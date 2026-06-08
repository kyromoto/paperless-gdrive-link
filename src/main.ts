import "dotenv/config";

import fs from "node:fs/promises";
import type http from "node:http";
import path from "node:path";
import logtape from "@logtape/logtape";
import { DEFAULT_REDACT_FIELDS, JWT_PATTERN, redactByField, redactByPattern } from "@logtape/redaction";
import * as bullmq from "bullmq";
import { addExitCallback } from "catch-exit";
import express from "express";
import helmet from "helmet";
import IORedis, { type RedisOptions } from "ioredis";
import { err, ok, Result } from "neverthrow";
import { ConfigFileRepository } from "./config-repository";
import { handleHealthCheck, handleWebhook } from "./controllers";
import type { RenewChannelJobPayload } from "./drive-monitor";
import { DriveMonitor } from "./drive-monitor";
import * as env from "./env";
import {
	type CollectChangesJobPayload,
	type CollectChangesJobResult,
	FileProcessor,
	type ProcessChangesJobPayload,
	type ProcessChangesJobResult,
} from "./file-processor";
import { FileStore } from "./file-store";
import { getDriveClient } from "./lib";
import { makeCollectChangesQueueProcessor, makeProcessChangesQueueProcessor } from "./queue-processor";
import { attachWorkerLogging } from "./queue-utils";

type ProcessFileBulkJob = {
	name: string;
	data: ProcessChangesJobPayload;
	opts: bullmq.BulkJobOptions;
};

const ROOT_LOGGER_KEY = "app";

(async () => {
	const startTime = Date.now();

	console.info(`App version: ${process.env.npm_package_version}`);

	addExitCallback(async (signal) => {
		logger.info(`Shutting down... | Signal: ${signal}`, { signal });

		logger.info("Stopping http server ...");
		new Promise<void>((resolve, reject) =>
			server.close((err) => {
				return err ? reject(err) : resolve();
			}),
		).catch((err) =>
			logger.error(`Failed to stop http server: ${err.message}`, {
				error: err,
			}),
		);

		logger.info(`Quit redis connection ...`);
		redisConnection.quit().catch((err) => {
			logger.error(`Failed to quit redis connection: ${err.message}`, {
				error: err,
			});
		});

		logger.info(`Stopping monitors ...`);
		Promise.all(
			Object.entries(monitors).map(([_accountId, monitor]) => {
				return monitor.stop();
			}),
		);

		logger.info(`Goodbye!`);
	});

	await logtape.configure({
		sinks: {
			console: redactByField(
				logtape.getConsoleSink({
					formatter: redactByPattern(logtape.defaultConsoleFormatter, [JWT_PATTERN]),
				}),
				[...DEFAULT_REDACT_FIELDS, "private_key"],
			),
		},
		loggers: [
			{
				category: [ROOT_LOGGER_KEY],
				sinks: ["console"],
				lowestLevel: env.LOG_LEVEL,
			},
			{
				category: ["logtape", "meta"],
				sinks: ["console"],
				lowestLevel: env.LOG_LEVEL,
			},
		],
	});

	const logger = logtape.getLogger(ROOT_LOGGER_KEY);

	logger.info("Loading env ...");
	logger.info(Object.entries(env).reduce((obj, [key, value]) => Object.assign(obj, { [key]: value }), {}));

	logger.info("Loading config ...");
	const config = await new ConfigFileRepository(logger.getChild("config-repository"), env.CONFIG_PATH).read();
	logger.debug(config);

	logger.info("Check data path exists ...");
	await fs.access(config.server.data_path).catch(async () => {
		logger.warn(`Data path ${config.server.data_path} does not exist, creating...`);
		await fs.mkdir(config.server.data_path, { recursive: true });
	});

	logger.info("Initializing file store ...");
	const fileStore = new FileStore(path.join(config.server.data_path, "files"));
	await fileStore.init();

	const monitors = new Map<string, DriveMonitor>();
	const processors = new Map<string, FileProcessor>();

	logger.info(`Connecting to redis at ${config.server.queue.redis.url} ...`);

	const redisOptions: RedisOptions = { maxRetriesPerRequest: null };
	const redisConnection = new IORedis(config.server.queue.redis.url, redisOptions);

	await new Promise<void>((resolve, reject) => {
		redisConnection.once("ready", resolve);
		redisConnection.once("error", reject);
	});

	logger.info("Initializing queues ...");
	const queueOptions: bullmq.QueueOptions = {
		connection: redisConnection,
		prefix: config.server.queue.redis.prefix,
	};

	const workerOptions: bullmq.WorkerOptions = {
		connection: redisConnection,
		prefix: config.server.queue.redis.prefix,
		removeOnComplete: { count: 100 },
		removeOnFail: { count: 10 },
	};

	const collectChangesQueue = new bullmq.Queue<CollectChangesJobPayload, CollectChangesJobResult>(
		"collect-changes",
		queueOptions,
	);

	const processChangesQueue = new bullmq.Queue<ProcessChangesJobPayload, ProcessChangesJobResult>(
		"process-changes",
		queueOptions,
	);

	const renewChannelQueue = new bullmq.Queue<RenewChannelJobPayload>("renew-channel", queueOptions);

	const collectChangesWorker = new bullmq.Worker(
		collectChangesQueue.name,
		makeCollectChangesQueueProcessor(logger.getChild(collectChangesQueue.name), config, processors),
		{ ...workerOptions, concurrency: config.server.queue.concurrency.collect },
	);

	const processChangesWorker = new bullmq.Worker(
		processChangesQueue.name,
		makeProcessChangesQueueProcessor(processors),
		{ ...workerOptions, concurrency: config.server.queue.concurrency.process },
	);

	const renewChannelWorker = new bullmq.Worker<RenewChannelJobPayload>(
		renewChannelQueue.name,
		async (job) => {
			const monitor = monitors.get(job.data.accountId);
			if (!monitor) {
				logger.error(`No monitor found for accountId ${job.data.accountId}`);
				return;
			}
			await monitor.start();
		},
		workerOptions,
	);

	attachWorkerLogging<CollectChangesJobPayload, CollectChangesJobResult>(
		logger,
		collectChangesWorker,
		collectChangesQueue,
		(d) => `${d?.accountId ?? "unknown-account"} collecting changes`,
		async (job, files) => {
			logger
				.getChild([collectChangesQueue.name, job.id ?? "unknown-id"])
				.info(`${files.length} files collected`, { job, files });
			await processChangesQueue.addBulk(
				files.map((file) => ({
					name: "process-changes",
					data: { accountId: job.data.accountId, file },
					opts: { jobId: `process-changes-${job.data.accountId}-${file.id}` },
				})),
			);
		},
	);

	attachWorkerLogging(
		logger,
		processChangesWorker,
		processChangesQueue,
		(d) => `${d?.file.name ?? "unknown-file"} processing`,
	);

	attachWorkerLogging(
		logger,
		renewChannelWorker,
		renewChannelQueue,
		(d) => `${d?.accountId ?? "unknown-account"} channel renewal`,
	);

	logger.info("Initializing file processors ...");

	const initProcessorsResult = Result.combineWithAllErrors(
		config.accounts.map((account) => {
			const driveAccount = config.drive_accounts.find((drive) => drive.id === account.props.drive_account_id);

			if (!driveAccount) {
				return err({
					accountId: account.id,
					message: `Failed to find drive account for ${account.name}`,
				});
			}

			processors.set(
				account.id,
				new FileProcessor(
					logger.getChild(["file-processor", account.name]),
					config,
					fileStore,
					account,
					getDriveClient(driveAccount),
				),
			);

			return ok();
		}),
	);

	if (initProcessorsResult.isErr()) {
		initProcessorsResult.error.forEach((error) => {
			logger.error(error.message, { error });
		});
		throw new Error("Failed to initialize drive clients");
	}

	logger.info("Initializing drive monitors ...");
	for (const account of config.accounts) {
		monitors.set(
			account.id,
			new DriveMonitor(logger.getChild(["drive-monitor", account.name]), config, account, renewChannelQueue),
		);
	}

	logger.info("Collect outstanding files from watchfolders ...");
	const processingJobs = (
		await Promise.all(
			Array.from(processors.entries()).map<Promise<ProcessFileBulkJob[]>>(async ([accountId, processor]) => {
				const files = await processor.getUnprocessedFiles("all");
				return files.map<ProcessFileBulkJob>((file) => ({
					name: processChangesQueue.name,
					data: { accountId, file },
					opts: { jobId: `process-changes-${accountId}-${file.id}` },
				}));
			}),
		)
	).flat();

	logger.info(`Queue ${processingJobs.length} outstanding files for processing ...`, { processingJobs });
	await processChangesQueue.addBulk(processingJobs);

	logger.info(`Starting http server at port ${config.server.http.port}...`);
	const app = express();

	app.use(helmet());
	app.use(express.json());
	app.get("/health", handleHealthCheck());
	app.post("/webhook", handleWebhook(logger.getChild("webhook-controller"), config, collectChangesQueue, monitors));

	const server = await new Promise<http.Server>((resolve, reject) => {
		const server = app.listen(config.server.http.port, (err) => {
			err ? reject(err) : resolve(server);
		});
	});

	logger.info("Clearing stale renew-channel jobs ...");
	await renewChannelQueue.drain();

	logger.info("Starting drive monitors ...");
	await Promise.all(Array.from(monitors.values()).map((monitor) => monitor.start()));

	const elapsedMs = (Date.now() - startTime) / 1000;
	logger.info(`Application started in ${elapsedMs} seconds`);
})();

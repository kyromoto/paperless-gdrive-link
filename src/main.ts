import "dotenv/config"

import fs from "node:fs/promises"
import path from "node:path"

import * as bullmq from "bullmq"
import helmet from "helmet"
import express from "express"
import IORedis, { RedisOptions} from "ioredis"
import logtape from "@logtape/logtape"
import { DEFAULT_REDACT_FIELDS, JWT_PATTERN, redactByField, redactByPattern } from "@logtape/redaction"

import * as env from "./env"
import { FileStore } from "./file-store"
import { DriveMonitor } from "./drive-monitor"
import { makeTaskScheduler } from "./task-scheduler"
import { ConfigFileRepository } from "./config-repository"
import { handleHealthCheck, handleWebhook } from "./controllers"
import { makeCollectChangesQueueProcessor, makeProcessChangesQueueProcessor } from "./queue-processor"
import { CollectChangesJobPayload, CollectChangesJobResult, DriveFile, FileProcessor, ProcessChangesJobPayload, ProcessChangesJobResult } from "./file-processor"



const main = async () => {

    await logtape.configure({
        sinks: {
            console: redactByField(logtape.getConsoleSink({
                formatter: redactByPattern(logtape.defaultConsoleFormatter, [
                    JWT_PATTERN
                ])
            }), [
                ...DEFAULT_REDACT_FIELDS,
                "private_key"
            ])
        },
        loggers: [
            { category: [], sinks: ["console"], lowestLevel: env.LOG_LEVEL },
            { category: ["logtape" ,"meta"], sinks: ["console"], lowestLevel: env.LOG_LEVEL }
        ]
    })

    const logger = logtape.getLogger()
    const config = await new ConfigFileRepository(env.CONFIG_PATH).read().catch(err => {
        logger.error(`Failed to read config from ${env.CONFIG_PATH}: ${err.message}`, { error: err })
        process.exit(1)
    })

    logger.getChild("env").info(Object.entries(env).reduce((obj, [key, value]) => Object.assign(obj, { [key]: value } ), {}))
    logger.getChild("config").info(config)

    await fs.access(config.server.data_path).catch(async err => {
        logger.warn(`Data path ${config.server.data_path} does not exist, creating...`)
        await fs.mkdir(config.server.data_path, { recursive: true })
    })

    const fileStore = new FileStore(path.join(config.server.data_path, "files"))
    const taskScheduler = makeTaskScheduler(config.server.task_schedular.interval_ms, config.server.task_schedular.concurrency)
    const monitors = new Map<string, DriveMonitor>()
    const processors = new Map<string, FileProcessor>()

    await fileStore.init()

    const redisOptions: RedisOptions = { maxRetriesPerRequest: null }
    const redisConnection = new IORedis(config.server.queue.redis.url, redisOptions)

    await new Promise<void>((resolve, reject) => {
        redisConnection.once("ready", resolve)
        redisConnection.once("error", reject)
    }).catch(err => {
        logger.getChild("redis").error(`Failed to connect at ${config.server.queue.redis.url}: ${err.message}`, { error: err })
    })

    logger.getChild("redis").info(`Connected at ${config.server.queue.redis.url}`)

    const queueOptions: bullmq.QueueOptions = {
        connection: redisConnection,
        prefix: config.server.queue.redis.prefix
    }

    const workerOptions: bullmq.WorkerOptions = {
        connection: redisConnection,
        prefix: config.server.queue.redis.prefix,
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 10 }
    }

    const collectChangesQueue = new bullmq.Queue<CollectChangesJobPayload, CollectChangesJobResult>("collect-changes", queueOptions)
    const processChangesQueue = new bullmq.Queue<ProcessChangesJobPayload, ProcessChangesJobResult>("process-changes", queueOptions)
    const collectChangesWorker = new bullmq.Worker(
        collectChangesQueue.name,
        makeCollectChangesQueueProcessor(logger.getChild(collectChangesQueue.name), config, processors),
        { ...workerOptions, concurrency: config.server.queue.concurrency.collect }
    )
    const processChangesWorker = new bullmq.Worker(
        processChangesQueue.name,
        makeProcessChangesQueueProcessor(logger.getChild(processChangesQueue.name), config, processors),
        { ...workerOptions, concurrency: config.server.queue.concurrency.process }
    )

    collectChangesWorker.on("active", job => {
        logger.getChild([collectChangesQueue.name, job.id?.toString() || "unkown-id"]).info(`${job.data.accountId} collecting changes started`, { job })
    })

    collectChangesWorker.on("completed", async (job, files) => {
        logger.getChild([collectChangesQueue.name, job.id?.toString() || "unkown-id"]).info(`${files.length} files collected`, { job, files })
        await processChangesQueue.addBulk(files.map(file => ({ name: "process-changes", data: { accountId: job.data.accountId, file }, opts: { jobId: crypto.randomUUID() } })))
    })

    collectChangesWorker.on("failed", (job, error) => {
        logger.getChild([collectChangesQueue.name, job?.id?.toString() || "unkown-id"]).error(`${job?.data.accountId || "unkown-account"} collecting changes failed: ${error.message}`, { job, error })
    })

    collectChangesQueue.on("error", error => {
        logger.getChild(collectChangesQueue.name).error(`queue error: ${error.message}`, { error })
    })


    processChangesWorker.on("active", job => {
        logger.getChild([processChangesQueue.name, job.id?.toString() || "unkown-id"]).info(`${job.data.file.name} processing started`, { job })
    })

    processChangesWorker.on("completed", (job, result) => {
        logger.getChild([processChangesQueue.name, job.id?.toString() || "unkown-id"]).info(`${job.data.file.name} processed`, { result })
    })

    processChangesWorker.on("failed", (job, error) => {
        logger.getChild([processChangesQueue.name, job?.id?.toString() || "unkown-id"]).error(`${job?.data.file.name || "unkown-file"} processing failed: ${error.message}`, { error })
    })

    processChangesQueue.on("error", error => {
        logger.getChild(processChangesQueue.name).error(`queue error: ${error.message}`, { error })
    })

    const app = express();

    app.use(helmet())
    app.use(express.json());
    app.get("/health", handleHealthCheck())
    app.post("/webhook", handleWebhook(config, collectChangesQueue, monitors, processors))

    config.accounts.forEach(account => {
        processors.set(account.id, new FileProcessor(config, fileStore, account))
        monitors.set(account.id, new DriveMonitor(config, account, taskScheduler))
    })

    await Promise.all(config.accounts.map(async account => {
        
        const processor = processors.get(account.id)

        if (!processor) {
            throw new Error(`Processor not found for account ${account.id}`)
        }

        const files = await processor.getUnprocessedFiles("all")
        const jobs = files.map(file => ({ name: collectChangesQueue.name, data: { accountId: account.id, file }, opts: { jobId: crypto.randomUUID() } }))
        
        return processChangesQueue.addBulk(jobs)

    }))

    await new Promise<void>((resolve, reject) => {
        const log = logger.getChild("http-server")
        app.listen(config.server.http.port, err => {
            if (err) {
                log.error(`Failed to start: ${err.message}`, { error: err })
                return reject(err)
            } else {
                log.info(`Listening on port ${config.server.http.port}`)
                return resolve()
            }
        })
    })

    await Promise.all(config.accounts.map(async account => {

        const monitor = monitors.get(account.id)

        if (!monitor) {
            throw new Error(`Monitor not found for account ${account.id}`)
        }

        return monitor.start()

    }))

    const handleShutdown = async () => {
        for (const [accountId, monitor] of monitors.entries()) {
            await monitor.stop().catch(err => {
                const account = config.accounts.find(account => account.id === accountId)!
                logger.error(`${account.name}: Failed to stop drive monitor: ${err.message}`, { error: err })
            })
        }
    }

    process.on("SIGINT", async () => await handleShutdown())
    process.on("SIGTERM", async () => await handleShutdown())
    process.on("SIGHUP", async () => await handleShutdown())

    logger.info("Application started :-)")

}

main().catch(error => {
    console.error('Failed to start application', error);
    process.exit(1);
})
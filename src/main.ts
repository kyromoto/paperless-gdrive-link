import "dotenv/config"

import fs from "node:fs/promises"
import path from "node:path"
import http from "node:http"

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
import { addExitCallback } from "catch-exit"


type ProcessFileBulkJob = { name: string, data: ProcessChangesJobPayload, opts: bullmq.BulkJobOptions }

const ROOT_LOGGER_KEY = "app";


(async () => {

    const startTime = Date.now()

    addExitCallback(async signal => {
        
        logger.info(`Shutting down... | Signal: ${signal}`, { signal })

        logger.info("Stopping http server ...")
        new Promise<void>((resolve, reject) => server.close(err => {
            return err ? reject(err) : resolve()
        })).catch(err => logger.error(`Failed to stop http server: ${err.message}`, { error: err }))

        logger.info(`Quit redis connection ...`)
        redisConnection.quit().catch(err => {
            logger.error(`Failed to quit redis connection: ${err.message}`, { error: err })
        })

        logger.info(`Stopping monitors ...`)
        Promise.all(Object.entries(monitors).map(([accountId, monitor]) => {
            return monitor.stop()
        }))

        logger.info(`Goodbye!`)
    })

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
            { category: [ROOT_LOGGER_KEY], sinks: ["console"], lowestLevel: env.LOG_LEVEL },
            { category: ["logtape" ,"meta"], sinks: ["console"], lowestLevel: env.LOG_LEVEL }
        ]
    })

    const logger = logtape.getLogger(ROOT_LOGGER_KEY)


    logger.info("Loading env ...")
    logger.info(Object.entries(env).reduce((obj, [key, value]) => Object.assign(obj, { [key]: value } ), {}))
    
    logger.info("Loading config ...")
    const config = await new ConfigFileRepository(logger.getChild("config-repository"), env.CONFIG_PATH).read()
    logger.debug(config)



    logger.info("Check data path exists ...")
    await fs.access(config.server.data_path).catch(async err => {
        logger.warn(`Data path ${config.server.data_path} does not exist, creating...`)
        await fs.mkdir(config.server.data_path, { recursive: true })
    })



    logger.info("Initializing file store ...")
    const fileStore = new FileStore(path.join(config.server.data_path, "files"))
    await fileStore.init()



    logger.info("Initializing task scheduler ...")
    const taskScheduler = makeTaskScheduler(logger.getChild("task-scheduler"), {
        intervalMs: config.server.task_schedular.interval_ms,
        maxConcurrentTasks: config.server.task_schedular.concurrency
    })
    
    const monitors = new Map<string, DriveMonitor>()
    const processors = new Map<string, FileProcessor>()



    logger.info(`Connecting to redis at ${config.server.queue.redis.url} ...`)

    const redisOptions: RedisOptions = { maxRetriesPerRequest: null }
    const redisConnection = new IORedis(config.server.queue.redis.url, redisOptions)
    
    await new Promise<void>((resolve, reject) => {
        redisConnection.once("ready", resolve)
        redisConnection.once("error", reject)
    })



    logger.info("Initializing queues ...")
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


    
    logger.info("Initializing file processors ...")
    config.accounts.forEach(account => processors.set(account.id, new FileProcessor(logger.getChild(["file-processor", account.name]), config, fileStore, account)))
    
    logger.info("Initializing drive monitors ...")
    config.accounts.forEach(account => monitors.set(account.id, new DriveMonitor(logger.getChild(["drive-monitor", account.name]), config, account, taskScheduler)))



    logger.info("Collect outstanding files from watchfolders ...")
    const processingJobs = (await Promise.all(Array
        .from(processors.entries())
        .map<Promise<ProcessFileBulkJob[]>>(async ([accountId, processor]) => {
            const files = await processor.getUnprocessedFiles("all")
            return files.map<ProcessFileBulkJob>(file => ({
                name: collectChangesQueue.name,
                data: { accountId, file },
                opts: { jobId: crypto.randomUUID() }
            }))
        }))).flat()

    logger.info(`Queue ${processingJobs.length} outstanding files for processing ...`, { processingJobs })
    await processChangesQueue.addBulk(processingJobs)



    logger.info(`Starting http server at port ${config.server.http.port}...`)
    const app = express()

    app.use(helmet())
    app.use(express.json());
    app.get("/health", handleHealthCheck())
    app.post("/webhook", handleWebhook(logger.getChild("webhook-controller"), config, collectChangesQueue, monitors, processors))

    const server = await new Promise<http.Server>((resolve, reject) => {
        const server = app.listen(config.server.http.port, err => {
            err ? reject(err) : resolve(server)
        })
    })



    logger.info("Starting drive monitors ...")
    await Promise.all(Array.from(monitors.values()).map(monitor => monitor.start()))



    logger.info(`Application started in ${(Date.now() - startTime) / 1000} seconds`)

})()
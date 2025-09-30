import "dotenv/config"

import fs from "node:fs/promises"
import path from "node:path"

import bull from "bull"
import helmet from "helmet"
import express from "express"
import Redis, { RedisOptions } from "ioredis"
import logtape from "@logtape/logtape"
import { DEFAULT_REDACT_FIELDS, JWT_PATTERN, redactByField, redactByPattern } from "@logtape/redaction"

import * as env from "./env"
import { FileStore } from "./file-store"
import { DriveMonitor } from "./drive-monitor"
import { makeTaskScheduler } from "./task-scheduler"
import { ConfigFileRepository } from "./config-repository"
import { handleHealthCheck, handleWebhook } from "./controllers"
import { makeCollectChangesQueueProcessor, makeProcessChangesQueueProcessor } from "./queue-processor"
import { CollectChangesJobPayload, DriveFile, FileProcessor, ProcessChangesJobPayload } from "./file-processor"



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

    const redisOpts: bull.QueueOptions = (() => {

        const options: RedisOptions = {
            enableReadyCheck: false,
            maxRetriesPerRequest: null
        }

        const client = new Redis(config.server.queue.redis.url)
        const subscriber = new Redis(config.server.queue.redis.url, options)

        return {
            prefix: config.server.queue.redis.prefix,
            createClient: type => {
                switch (type) {
                    case "client": return client
                    case "subscriber": return subscriber
                    default: return new Redis(config.server.queue.redis.url, options)
                }
            },
            defaultJobOptions: {
                jobId: crypto.randomUUID()
            }
        }

    })()

    const collectChangesQueue = new bull<CollectChangesJobPayload>("collect-changes", redisOpts)
    const processChangesQueue = new bull<ProcessChangesJobPayload>("process-changes", redisOpts)

    await collectChangesQueue.isReady().catch(err => {
        logger.getChild(collectChangesQueue.name).error(`Start failed: ${err.message}`, { error: err })
    })
    logger.getChild(collectChangesQueue.name).info("started")

    await processChangesQueue.isReady().catch(err => {
        logger.getChild(processChangesQueue.name).error(`Start failed: ${err.message}`, { error: err })
    })
    logger.getChild(processChangesQueue.name).info("started")

    collectChangesQueue.process(config.server.queue.concurrency.collect, makeCollectChangesQueueProcessor(logger.getChild(collectChangesQueue.name), config, processors))
    processChangesQueue.process(config.server.queue.concurrency.process, makeProcessChangesQueueProcessor(logger.getChild(processChangesQueue.name), config, processors))

    collectChangesQueue.on("active", job => {
        logger.getChild([collectChangesQueue.name, job.id.toString()]).info(`${job.data.accountId} collecting changes started`, { job })
    })

    collectChangesQueue.on("completed", async (job, files: DriveFile[]) => {
        logger.getChild([collectChangesQueue.name, job.id.toString()]).info(`${files.length} files collected`, { job, files })
        await processChangesQueue.addBulk(files.map(file => ({ data: { accountId: job.data.accountId, file }, opts: { jobId: crypto.randomUUID() } })))
    })

    collectChangesQueue.on("failed", (job, error) => {
        logger.getChild([collectChangesQueue.name, job.id.toString()]).error(`${job.data.accountId} collecting changes failed: ${error.message}`, { job, error })
    })

    collectChangesQueue.on("error", error => {
        logger.getChild(collectChangesQueue.name).error(`queue error: ${error.message}`, { error })
    })


    processChangesQueue.on("active", job => {
        logger.getChild([processChangesQueue.name, job.id.toString()]).info(`${job.data.file.name} processing started`, { job })
    })

    processChangesQueue.on("completed", (job, result) => {
        logger.getChild([processChangesQueue.name, job.id.toString()]).info(`${job.data.file.name} processed`, { result })
    })

    processChangesQueue.on("failed", (job, error) => {
        logger.getChild([processChangesQueue.name, job.id.toString()]).error(`${job.data.file.name} processing failed: ${error.message}`, { error })
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
        const jobs = files.map(file => ({ data: { accountId: account.id, file }, opts: { jobId: crypto.randomUUID() } }))
        
        return processChangesQueue.addBulk(jobs)

    }))

    await new Promise<void>((resolve, reject) => {
        const log = logger.getChild("http-server")
        app.listen(config.server.http.port, err => {
            if (err) {
                log.error(`Start failed: ${err.message}`, { error: err })
                return reject(err)
            } else {
                log.info(`Start done: listening on port ${config.server.http.port}`)
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
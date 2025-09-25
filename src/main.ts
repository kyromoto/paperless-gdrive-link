import "dotenv/config"

import fs from "node:fs/promises"

import helmet from "helmet"
import express from "express"
import { configure, getConsoleSink, getLogger, defaultConsoleFormatter } from "@logtape/logtape"
import { DEFAULT_REDACT_FIELDS, JWT_PATTERN, redactByField, redactByPattern } from "@logtape/redaction"

import * as env from "./env"
import { DriveMonitor } from "./drive-monitor"
import { FileProcessor } from "./file-processor"
import { ConfigFileRepository } from "./config"
import { handleHealthCheck, handleWebhook } from "./controllers"
import { createFileTask } from "./lib"
import { ConcurrentQueue } from "./queue"
import { makeTaskScheduler } from "./task-scheduler"



const main = async () => {

    await configure({
        sinks: {
            console: redactByField(getConsoleSink({
                formatter: redactByPattern(defaultConsoleFormatter, [
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

    const logger = getLogger()

    logger.info("Starting ...")

    const config = await new ConfigFileRepository(env.CONFIG_PATH).read();

    getLogger().getChild("env").info(Object.entries(env).reduce((obj, [key, value]) => Object.assign(obj, { [key]: value } ), {}))
    getLogger().getChild("config").info(config)

    await fs.access(config.server.data_path).catch(err => {
        throw new Error(`Failed to access data path ${config.server.data_path}: ${err.message}`)
    })

    const taskScheduler = makeTaskScheduler(config.server.task_schedular.interval_ms, config.server.task_schedular.concurrency)

    const monitors = new Map<string, DriveMonitor>()
    const processors = new Map<string, FileProcessor>()

    const fileQueue = new ConcurrentQueue("File-Queue", config.server.file_queue.concurrency)
    const notificationQueue = new ConcurrentQueue("Notification-Queue", config.server.notification_queue.concurrency)

    const app = express();

    app.use(helmet())
    app.use(express.json());
    app.get("/health", handleHealthCheck())
    app.post("/webhook", handleWebhook(config, notificationQueue, monitors, processors))

    await new Promise <void> ((resolve, reject) => {
        app.listen(config.server.http.port, err => {
        
            if (err) {
                logger.error(`Failed to start server: ${err.message}`, { error: err })
                return reject(err)
            }
    
            logger.info(`Server started on port ${config.server.http.port}`)
            return resolve()
        })
    })

    config.accounts.forEach(account => {
        processors.set(account.id, new FileProcessor(config, account))
        monitors.set(account.id, new DriveMonitor(config, account, taskScheduler))
    })

    await Promise.all(config.accounts.map(async account => {
        
        const processor = processors.get(account.id)
        const monitor = monitors.get(account.id)

        if (!processor) {
            throw new Error(`Processor not found for account ${account.id}`)
        }

        if (!monitor) {
            throw new Error(`Monitor not found for account ${account.id}`)
        }


        for (const file of await processor.getUnprocessedFiles("all")) {
            const taskLogger = getLogger().getChild(["file-task", account.name])
            fileQueue.enqueue(createFileTask(taskLogger, processor, file))
        }
        
        await monitor.start()

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
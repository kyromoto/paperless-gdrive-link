import express from "express"
import { configure, getConsoleSink, getLogger } from "@logtape/logtape"

import { Queue } from "./queue"
import { DriveMonitor } from "./drive-monitor"
import { FileProcessor } from "./file-processor"
import { ConfigFileRepository } from "./config"
import { handleHealthCheck, handleWebhook } from "./controllers"
import { FileQueueJob, fileQueueWorker, notificationQueueWorker } from "./worker"




const main = async () => {

    await configure({
        sinks: { console: getConsoleSink() },
        loggers: [
            { category: [], sinks: ["console"] },
            { category: ["logtape" ,"meta"], sinks: ["console"], lowestLevel: "trace" }
        ]
    })

    const logger = getLogger()
    
    const config = await new ConfigFileRepository("config.json").read();

    const monitors = new Map<string, DriveMonitor>()
    const processors = new Map<string, FileProcessor>()

    const fileQueue: Queue<FileQueueJob> = new Queue("File-Queue", fileQueueWorker(config, processors))
    const notificationQueue: Queue<string> = new Queue("Notification-Queue", notificationQueueWorker(config, fileQueue, processors))

    const PORT = 8080
    const app = express();

    app.use(express.json());
    app.get("/health", handleHealthCheck())
    app.post("/webhook", handleWebhook(config, notificationQueue, monitors))

    await new Promise <void> ((resolve, reject) => {
        app.listen(PORT, err => {
        
            if (err) {
                logger.error(`Failed to start server: ${err.message}`, { error: err })
                return reject(err)
            }
    
            logger.info(`Server started on port ${PORT}`)
            return resolve()
        })
    })

    config.accounts.forEach(account => {
        processors.set(account.id, new FileProcessor(config, account))
        monitors.set(account.id, new DriveMonitor(config, account))
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

        const added = await processor.getUnprocessedFiles("all")
        added.forEach(file => fileQueue.enqueue({ account, file }))
        
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

    console.log("Application started!")
    console.log("Press Ctrl+C to stop")

}

main().catch(error => {
    console.error('Failed to start application', error);
    process.exit(1);
})
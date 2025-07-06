import { getLogger } from "@logtape/logtape"
import { Request, Response } from "express"

import { DriveMonitor } from "./drive-monitor"
import { Config } from "./types"
import { ConcurrentQueue } from "./queue"
import { FileProcessor } from "./file-processor"
import { createFileTask, createNotificationTask } from "./lib"



export const handleWebhook = (config: Config, queue: ConcurrentQueue, monitors: Map<string, DriveMonitor>, processors: Map<string, FileProcessor>) => {

    const logger = getLogger().getChild("webhook-controller")

    return async (req: Request, res: Response) => {

        try {

            logger.info('Handling request ...')

            const channelId = req.get('X-Goog-Channel-Id');
            const state = req.get('X-Goog-Resource-State');

            const accountId = Array.from(monitors.entries()).find(([accountId, monitor]) => monitor.getChannelId() === channelId)?.[0]

            if (!channelId) {
                throw new AcceptableWebhookError(`Received webhook without channel id ... ignoring`, 200, "OK")
            }

            if (!state) {
                throw new AcceptableWebhookError(`Received webhook without state ... ignoring`, 200, "OK")
            }

            const account = config.accounts.find(account => account.id === accountId)
            if (!account) {
                throw new AcceptableWebhookError(`Received webhook for unknown channel id ... ignoring`, 200, "OK")
            }

            const processor = processors.get(account.id)
            if (!processor) {
                throw new AcceptableWebhookError(`Failed to find processor for ${account.name}`, 200, "OK")
            }

            if (state.toLowerCase() === 'sync') {
                throw new AcceptableWebhookError(`Received sync webhook for account ${account.name}`, 200, "OK")
            }

            const result = queue.enqueue(createNotificationTask(getLogger().getChild(["notification-task", account.name]), processor))
            
            result.then(files => {
                for (const file of files) {
                    const taskLogger = getLogger().getChild(["file-task", account.name, file.name])
                    const task = createFileTask(taskLogger, processor, file)
                    queue.enqueue(task)
                }
            })

            res.status(200).send("OK")

        } catch (err: any) {

            if (err instanceof AcceptableWebhookError) {
                logger.warn(err.message, { headers: req.headers, ...err.props })
                res.status(err.status).send(err.body)
                return
            }

            logger.error(`Failed to handle webhook: ${err.message}`, { error: err })
            res.status(200).send("OK")
            return

        }

    }

}



export const handleHealthCheck = () => {

    return async (req: Request, res: Response) => {
        res.status(200).json({ status: "OK" });
    }

}



class AcceptableWebhookError extends Error {

    constructor(message: string, public readonly status: number, public readonly body: string, public readonly props: any = {}) {
        super(message)
    }

}
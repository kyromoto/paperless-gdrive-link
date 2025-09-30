import bullmq from "bullmq"
import { getLogger } from "@logtape/logtape"
import { Request, Response } from "express"

import { Config } from "./types"
import { DriveMonitor } from "./drive-monitor"
import { FileProcessor, CollectChangesJobPayload } from "./file-processor"




export const handleWebhook = (config: Config, queue: bullmq.Queue<CollectChangesJobPayload>, monitors: Map<string, DriveMonitor>, processors: Map<string, FileProcessor>) => {

    const logger = getLogger().getChild("webhook-controller")

    return async (req: Request, res: Response) => {

        try {

            logger.info('Handling request ...')

            const channelId = req.get('X-Goog-Channel-Id');
            const state = req.get('X-Goog-Resource-State');

            if (!channelId) {
                throw new AcceptableWebhookError(`Received webhook without channel id ... ignoring`, 200, "OK")
            }

            if (!state) {
                throw new AcceptableWebhookError(`Received webhook without state ... ignoring`, 200, "OK")
            }

            const accountId = Array.from(monitors.entries()).find(([accountId, monitor]) => monitor.getChannelId() === channelId)?.[0]
            const account = config.accounts.find(account => account.id === accountId)

            if (!account) {
                throw new AcceptableWebhookError(`Received webhook for unknown channel id ... ignoring`, 200, "OK")
            }

            if (state.toLowerCase() === 'sync') {
                throw new AcceptableWebhookError(`${account.name}: Received sync webhook`, 200, "OK")
            }

            await queue.add(queue.name, { accountId: account.id }, {
                jobId: crypto.randomUUID(),
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
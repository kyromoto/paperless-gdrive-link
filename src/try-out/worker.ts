import { getLogger } from "@logtape/logtape"

import { Account, Config } from "./types"
import { Queue, QueueWorker } from "./queue"
import { FileProcessor, DriveFile } from "./file-processor"



export type FileQueueJob = {
    account: Account,
    file: DriveFile
}

export type NotificationQueueJob = string


export const notificationQueueWorker = (config: Config, fileQueue: Queue<FileQueueJob>, processors: Map<string, FileProcessor>) : QueueWorker<NotificationQueueJob> => {

    const logger = getLogger().getChild("notification-queue-worker")

    return async (accountId) => {

        logger.info(`Handle job for notification of ${accountId} ...`)

        const account = config.accounts.find(account => account.id === accountId)
        if (!account) {
            throw new Error(`Failed to find account ${accountId}`)
        }

        const processor = processors.get(account.id)
        if (!processor) {
            throw new Error(`Failed to find processor for ${account.name}`)
        }

        const files = await processor.getUnprocessedFiles("changes")
        files.forEach(file => fileQueue.enqueue({ account, file }))

    }

}



export const fileQueueWorker = (config: Config, processors: Map<string, FileProcessor>) : QueueWorker<FileQueueJob> => {
    
    const logger = getLogger().getChild("file-queue-worker")

    return async ({ account, file }) => {

        logger.info(`Handle file ${file.name} for account ${account.name}`, { account: account.name, file })

        const processor = processors.get(account.id)

        if (!processor) {
            throw new Error(`${account.name}: Processor not found`)
        }
        
        await processor.processFile(file)

    }

}
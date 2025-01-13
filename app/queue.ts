import * as log from "./logger.ts"

export abstract class Queue<T> {

    private queue: T[] = [];
    private isProcessing = false;


    async addToQueue(item: T) {

        this.queue.push(item)

        log.info("Added to queue", item)

        if (!this.isProcessing) {
            await this.processQueue()
        }

    }


    private async processQueue() {

        if (this.isProcessing || this.queue.length === 0) {
            return
        }

        this.isProcessing = true

        while (this.queue.length > 0) {

            log.info("Queue length", this.queue.length)
            
            const item = this.queue[0]

            try {

                log.info("Processing task", item)

                await this.processTask(item)

                this.queue.shift()

            } catch (err) {
                log.error("Failed to process task", item, err)
            }

        }

        this.isProcessing = false

    }

    protected abstract processTask(item: T): Promise<void>

}
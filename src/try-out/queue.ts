import { getLogger, Logger } from "@logtape/logtape"

export type QueueWorker<T> = (job: T) => Promise<void>



export class Queue<T> {

    private logger = getLogger().getChild(["queue", this.name])

    private readonly queue: Array<T> = []
    private isProcessing = false

    constructor (private readonly name: string, private readonly worker: QueueWorker<T>) {}

    public enqueue (job: T) {

        this.logger.debug(`Enqueuing job...`, { job })

        this.queue.push(job)

        if (!this.isProcessing) {
            this.processQueue().catch(err => {
                this.logger.error(`Failed to process queue: ${err.message}`, { error: err })
            })
        }

    }



    private async processQueue () {

        this.logger.debug(`Processing queue ... `, { length: this.queue.length })

        if (this.isProcessing) return;
        if (this.queue.length === 0) return;

        this.isProcessing = true;

        while (this.queue.length > 0) {

            this.logger.info(`Remaining jobs: ${this.queue.length}`)

            const job = this.queue.shift()

            if (!job) continue

            await this.worker(job).catch(err => {
                this.logger.error(`Failed to process job: ${err.message || err}`, { job, error: err })
            })

        }

        this.isProcessing = false
    }


}
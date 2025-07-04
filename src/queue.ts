import { Queue, QueueJob, QueueWorker } from "./processor";
import { getLogger } from "@logtape/logtape";


export class InMemoryQueue implements Queue  {

    private readonly logger = getLogger()
    private readonly queue: Array<QueueJob & { attempt: number }> = []
    
    private readonly MAX_ATTEMPTS = 3
    private isProcessing = false

    constructor (private readonly worker: QueueWorker) {}

    public enqueue (job: QueueJob) {

        this.logger.info(`${job.owner}: Enqueuing job... ${job.file.id}`)

        this.queue.push({ ...job, attempt: 1 })
        
        if (!this.isProcessing) {
            this.processQueue().catch(err => {
                this.logger.error('Failed to process queue', err)
            })
        }
    }


    private async processQueue () {

        this.logger.info('Processing queue...')
        
        if (this.isProcessing) return;
        if (this.queue.length === 0) return;

        this.isProcessing = true;

        while (this.queue.length > 0) {

            this.logger.info(`Jobs in Queue: ${this.queue.length}`)

            const job = this.queue.shift()

            if (!job) continue

            console.log(`${job.owner}: Processing file ${job.file.name} (attempt: ${job.attempt})`)

            await this.worker(job).catch(err => {
                this.logger.error(`${job.owner}: Failed to process file ${job.file.name} (attempt: ${job.attempt}) : ${err.message || err}`, { job, error: err })

                if (!(err instanceof JobProcessingError)) return
                if (!err.retrieable) return

                if (job.attempt < this.MAX_ATTEMPTS) {
                    job.attempt++
                    this.queue.push(job)
                }
            })
        }

        this.isProcessing = false
    }
}




export class JobProcessingError extends Error {
    constructor (message: string, public readonly retrieable: boolean) {
       super(message) 
    }
}
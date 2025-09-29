import { getLogger } from "@logtape/logtape"

type Task<T = any> = () => Promise<T>


type QueueItem<T = any> = {
    task: () => Promise<T>,
    resolve: (value: T) => void
    reject: (error: any) => void
}



export class ConcurrentQueue {

    private logger = getLogger().getChild(["concurrent-queue", this.name])

    private runningTasks = 0
    private queue: QueueItem[] = []

    constructor(private readonly name: string, private readonly concurrency: number = 1) {}


    public async enqueue<T> (task: Task<T>) : Promise<T> {
        return new Promise<T>((resolve, reject) => {
            this.queue.push({ task, resolve, reject })
            this.tryNext()
        })
    }



    private tryNext () {
        while (this.queue.length > 0 && this.runningTasks < this.concurrency) {
            this.doNext()
        }
    }

    private async doNext () {
        
        if (this.queue.length === 0) return
        
        const queueItem = this.queue.shift()!
        this.runningTasks++

        try {
            queueItem.resolve(await queueItem.task())
        } catch (error) {
            queueItem.reject(error)
        } finally {
            this.runningTasks--
            this.tryNext()
        }
    }


}
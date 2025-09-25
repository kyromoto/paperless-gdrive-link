import crypto from "node:crypto"
import { setInterval } from "node:timers/promises"

import { getLogger, Logger } from "@logtape/logtape"
import { addExitCallback } from "catch-exit"

export type TaskId = string & { __brand: "TaskId" }
export type TimeoutMs = number & { __brand: "TimeoutMs" }

export type TaskResult = { status: "success", data?: any } | { status: "failed", error: string }
export type TaskHandler = (taskId: TaskId, taskLogger: Logger) => Promise<TaskResult>
export type TaskTimeoutHandler = (taskId: TaskId, taskLogger: Logger) => Promise<void>


export type Task = {
    scheduledTime: Date
    timeoutMS: TimeoutMs
    handler: TaskHandler
    onTimeout?: TaskTimeoutHandler
}


export interface TaskScheduler {
    registerTask: (task: Task) => { taskId: TaskId, scheduledTime: Date }
}




export function makeTaskScheduler(intervalMs: number, maxConcurrentTasks: number): TaskScheduler {
    
    const logger = getLogger().getChild(["task-scheduler"])

    const scheduledTasks = new Map<TaskId, Task>()
    const runningTasks = new Set<TaskId>()

    const registerTask = (task: Task): { taskId: TaskId, scheduledTime: Date } => {
        const taskId = crypto.randomUUID() as TaskId
        scheduledTasks.set(taskId, task)
        return { taskId, scheduledTime: task.scheduledTime }
    }


    const executeTaskAsync = async (taskId: TaskId) => {
        
        const task = scheduledTasks.get(taskId)

        if (!task) {
            logger.warn(`Task ${taskId} not found`)
            return
        }

        runningTasks.add(taskId)

        try {

            const taskLogger = logger.getChild(taskId)
            
            const timeoutPromise = new Promise<TaskResult>((resolve, reject) => {
                const abortTimer = setTimeout(() => {
                    
                    task.onTimeout?.(taskId, taskLogger).catch(err => {
                        taskLogger.error(`Failed to execute onTimeout handler: ${err.message}`, { error: err })
                    })

                    resolve({ status: "failed", error: `Task timed out after ${task.timeoutMS}ms` })

                }, task.timeoutMS)
            })

            taskLogger.info("Executing task ...", { task })

            const start = new Date()

            const result = await Promise.race([
                task.handler(taskId, taskLogger),
                timeoutPromise
            ])

            const end = new Date()
            const duration = end.getTime() - start.getTime()

            switch (result.status) {
                case "success": {
                    taskLogger.info(`Task completed successfully`, { task, result, duration })
                    break
                }
                    
                case "failed": {
                    taskLogger.error(`Task failed`, { task, result, duration })
                    break
                }
            }

        } catch (error: any) {
            logger.error(`Failed to execute task ${taskId}: ${error.message}`, { error })
        } finally {
            runningTasks.delete(taskId)
            scheduledTasks.delete(taskId)
        }
    }


    const startScheduler = async () => {

        const abortController = new AbortController()
        
        logger.info(`Starting task Scheduler...`)

        addExitCallback(signal => {
            logger.info(`Aborting task Scheduler loop...`, { signal })
            abortController.abort()
        })

        for await (const _ of setInterval(intervalMs, { signal: abortController.signal })) {
            
            if (runningTasks.size >= maxConcurrentTasks) return

            const now = new Date()
            const availableSlots = maxConcurrentTasks - runningTasks.size
            const dueTasks = Array.from(scheduledTasks)
                .filter(([taskId, task]) => task.scheduledTime.getTime() - now.getTime() <= intervalMs)
                .sort((a, b) => a[1].scheduledTime.getTime() - b[1].scheduledTime.getTime())
                .slice(0, availableSlots)
                .map(([taskId, task]) => taskId)

            logger.debug(`Executing ${dueTasks.length} / ${scheduledTasks.size} tasks at ${now.toUTCString()}`, { dueTasks, now })
            dueTasks.forEach(taskId => executeTaskAsync(taskId))
            
        }

        logger.info(`Task Scheduler stopped`)
        
    }

    startScheduler().catch(err => {
        logger.error(`Scheduler failed: ${err.message}`, { error: err })
        process.exit(1)
    })


    return {
        registerTask
    }

}
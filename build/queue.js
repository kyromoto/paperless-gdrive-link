"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.JobProcessingError = exports.InMemoryQueue = void 0;
const logtape_1 = require("@logtape/logtape");
class InMemoryQueue {
    constructor(worker) {
        this.worker = worker;
        this.logger = (0, logtape_1.getLogger)();
        this.queue = [];
        this.MAX_ATTEMPTS = 3;
        this.isProcessing = false;
    }
    enqueue(job) {
        this.logger.info(`${job.owner}: Enqueuing job... ${job.file.id}`);
        this.queue.push(Object.assign(Object.assign({}, job), { attempt: 1 }));
        if (!this.isProcessing) {
            this.processQueue().catch(err => {
                this.logger.error('Failed to process queue', err);
            });
        }
    }
    processQueue() {
        return __awaiter(this, void 0, void 0, function* () {
            this.logger.info('Processing queue...');
            if (this.isProcessing)
                return;
            if (this.queue.length === 0)
                return;
            this.isProcessing = true;
            while (this.queue.length > 0) {
                this.logger.info(`Jobs in Queue: ${this.queue.length}`);
                const job = this.queue.shift();
                if (!job)
                    continue;
                console.log(`${job.owner}: Processing file ${job.file.name} (attempt: ${job.attempt})`);
                yield this.worker(job).catch(err => {
                    this.logger.error(`${job.owner}: Failed to process file ${job.file.name} (attempt: ${job.attempt}) : ${err.message || err}`, { job, error: err });
                    if (!(err instanceof JobProcessingError))
                        return;
                    if (!err.retrieable)
                        return;
                    if (job.attempt < this.MAX_ATTEMPTS) {
                        job.attempt++;
                        this.queue.push(job);
                    }
                });
            }
            this.isProcessing = false;
        });
    }
}
exports.InMemoryQueue = InMemoryQueue;
class JobProcessingError extends Error {
    constructor(message, retrieable) {
        super(message);
        this.retrieable = retrieable;
    }
}
exports.JobProcessingError = JobProcessingError;

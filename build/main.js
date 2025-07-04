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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
require("reflect-metadata");
const express_1 = __importDefault(require("express"));
const logtape_1 = require("@logtape/logtape");
const config_1 = require("./config");
const processor_1 = require("./processor");
const database_1 = require("./database");
(() => __awaiter(void 0, void 0, void 0, function* () {
    const CONFIG_PATH = process.env.CONFIG_PATH;
    if (!CONFIG_PATH) {
        console.error('Missing CONFIG_PATH environment variable');
        process.exit(1);
    }
    yield (0, logtape_1.configure)({
        sinks: { console: (0, logtape_1.getConsoleSink)() },
        loggers: [
            { category: [], sinks: ["console"] },
            { category: ["logtape", "meta"], sinks: ["console"], lowestLevel: "trace" }
        ]
    });
    yield database_1.Database.initialize();
    const app = (0, express_1.default)();
    const config = yield new config_1.ConfigFileRepository(CONFIG_PATH).read();
    const processor = new processor_1.Processor(config);
    yield processor.start();
}))().catch(error => {
    console.error('Failed to start application', error);
    process.exit(1);
});

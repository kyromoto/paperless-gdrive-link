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
exports.ConfigFileRepository = void 0;
const promises_1 = __importDefault(require("node:fs/promises"));
const logtape_1 = require("@logtape/logtape");
const types_1 = require("./types");
class ConfigFileRepository {
    constructor(path) {
        this.path = path;
        this.logger = (0, logtape_1.getLogger)();
    }
    read() {
        return __awaiter(this, void 0, void 0, function* () {
            this.logger.debug(`Reading config from ${this.path}`);
            const data = yield promises_1.default.readFile(this.path, 'utf-8');
            const json = JSON.parse(data);
            const config = yield types_1.Config.parseAsync(json);
            return config;
        });
    }
    write(config) {
        return __awaiter(this, void 0, void 0, function* () {
            this.logger.debug(`Writing config to ${this.path}`);
            const json = JSON.stringify(config, null, 2);
            yield promises_1.default.writeFile(this.path, json);
        });
    }
}
exports.ConfigFileRepository = ConfigFileRepository;

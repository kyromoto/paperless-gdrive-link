"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Database = exports.PageToken = void 0;
const typeorm_1 = require("typeorm");
// @Entity({ name: 'queue' })
// // @Index(['accountId', 'data'], { unique: true })
// export class QueueItem<T extends { id: string }> {
//     @PrimaryGeneratedColumn("uuid")
//     id: string;
//     @Column({ type: 'text' })
//     owner: string;
//     @Column({ type: 'text', transformer: { to: v => JSON.stringify(v), from: v => JSON.parse(v) } })
//     data: T;
//     @Column({ type: "integer", name: 'retries' })
//     retries: number
//     @CreateDateColumn()
//     createdAt: Date
//     @UpdateDateColumn()
//     updatedAt: Date
// }
let PageToken = class PageToken {
};
exports.PageToken = PageToken;
__decorate([
    (0, typeorm_1.PrimaryGeneratedColumn)("uuid"),
    __metadata("design:type", String)
], PageToken.prototype, "id", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'text', unique: true }),
    __metadata("design:type", String)
], PageToken.prototype, "owner", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'text' }),
    __metadata("design:type", String)
], PageToken.prototype, "token", void 0);
__decorate([
    (0, typeorm_1.CreateDateColumn)(),
    __metadata("design:type", Date)
], PageToken.prototype, "createdAt", void 0);
__decorate([
    (0, typeorm_1.UpdateDateColumn)(),
    __metadata("design:type", Date)
], PageToken.prototype, "updatedAt", void 0);
exports.PageToken = PageToken = __decorate([
    (0, typeorm_1.Entity)({ name: 'page_tokens' })
], PageToken);
exports.Database = new typeorm_1.DataSource({
    type: 'sqlite',
    database: 'database.sqlite',
    entities: [PageToken],
    synchronize: true
});

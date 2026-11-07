'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const { monthKey, imageStamp } = require('./time');

// 截图的文件系统存储：Phase 6 起 SQLite 只存元数据，图片仍然留在磁盘上（第 20 / 55 节）。
//
// 目录结构：
//   <base>/2026-09/images/2026-09-11_21-06-05-042.png
//
// 这里已经没有任何 JSON 读写：Activity 与 AI Job 的持久化全部迁到 SQLite
// （src/main/db/repositories/），不再有 SQLite + JSON 双写。
class Store {
  constructor(baseDir) {
    this.baseDir = baseDir;
  }

  monthDir(date) {
    return path.join(this.baseDir, monthKey(date));
  }

  imageDir(date) {
    return path.join(this.monthDir(date), 'images');
  }

  // 截图文件名保持不变（Phase 2/3 的命名规则），业务主键就是它去掉扩展名。
  async saveImage(buffer, date) {
    const dir = this.imageDir(date);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${imageStamp(date)}.png`);
    await fs.writeFile(file, buffer);
    return file;
  }
}

module.exports = { Store };

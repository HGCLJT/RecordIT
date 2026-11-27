# RecordIT · DoI

DoI 是一款日记app，适用于 iPhone 主屏幕 PWA 和 Android。可以离线记录经历，通过月历和统计回顾，也可以配对后与同步选中的记录、共享照片和视频。

## 主要功能

- **离线记录**　首次联网加载后，可以离线新增、编辑和查看本机记录。日期必填，时段、时长和感受按需填写。
- **月历与统计**　按日期或月份回看记录，通过热力图和统计查看记录分布。
- **情侣空间**　通过邀请码配对，选择要共享的记录。离线产生的共享记录会在恢复联网后同步。
- **共享相册**　配对后，双方可以在联网时上传和查看照片与视频。
- **备份与恢复**　支持导出和导入 JSON，方便备份和换机迁移。

## 本地运行

安装 Node.js 后，在项目根目录将 `wrangler.example.jsonc` 复制为 `wrangler.jsonc`。创建 `.dev.vars`，写入 `DOI_SETUP_KEY=你的随机开通码`。然后运行下面的 PowerShell 命令。

```powershell
npx.cmd --yes wrangler@4.165.0 d1 migrations apply DB --local
npx.cmd --yes wrangler@4.165.0 pages dev public --ip 127.0.0.1 --port 8742 --r2 ALBUM=doi-local-album
```

打开 [本地预览](http://127.0.0.1:8742/)。可在「设置 → 情侣空间」使用开通码创建测试空间。

## 部署与安装

- **Cloudflare Pages**　在 `wrangler.jsonc` 填写自己的 Pages 项目和 D1 数据库配置，通过 Pages Secrets 设置开通码。生产共享相册使用 Backblaze B2 私有存储桶。配置和部署步骤见 [PWA 开发方案](PWA开发方案.md#cloudflare-部署与-iphone-验收)。
- **iPhone**　在 Safari 打开部署后的 HTTPS 地址，通过分享菜单选择「添加到主屏幕」。
- **Android**　支持 Android 8.0 及以上。构建时通过 `-PdoiHost` 指定部署站点的域名，详见 [Android 构建说明](android/README.md)。

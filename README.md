# RecordIT · DoI

DoI 是一款日记app，适用于 iPhone 主屏幕 PWA 和 Android。可以离线记录亲密经历，通过月历和统计回顾，也可以配对后与伴侣同步选中的记录、共享照片和视频。

## 主要功能

- **离线记录**　首次联网加载后，可以离线新增、编辑和查看本机记录。日期必填，时段、时长和感受按需填写。
- **月历与统计**　按日期或月份回看记录，通过热力图和统计查看记录分布。
- **情侣空间**　通过邀请码配对，选择要共享的记录。离线产生的共享记录会在恢复联网后同步。
- **共享相册**　配对后，双方可以在联网时上传和查看照片与视频。
- **备份与恢复**　支持导出和导入 JSON，方便备份和换机迁移。

## 安装与首次使用

安装前需要一个已部署的 DoI HTTPS 地址。自行部署请见下方的 Cloudflare 部署说明。

### iPhone

1. 用 Safari 打开 DoI 的 HTTPS 地址。
2. 打开分享菜单，选择「添加到主屏幕」。如果看到「作为网页 App 打开」，请开启它，再点「添加」。
3. 回到主屏幕，点击 DoI 图标。首次打开时保持联网，让应用缓存离线资源。

[Apple 的主屏幕安装说明](https://support.apple.com/zh-cn/guide/iphone/iphea86e5236/27/ios/27)

### Android

1. 在 Android 8.0 或更新版本的手机上准备一份已签名并指向你的 DoI 站点的 APK。需要自己打包时，参照 [Android 构建与签名说明](android/README.md)。
2. 在手机的文件管理器中打开 APK。若系统要求授权，按提示允许当前来源安装，然后点「安装」。
3. 从应用列表打开 DoI，首次启动时保持联网。

[Google 的 APK 安装说明](https://support.google.com/pixelphone/answer/7391672?hl=en-in#zippy=%2Cdownload-apps-from-other-sources)

### 开始记录

- 在月历页点「新建记录」，确认日期并保存，即可开始使用本机记录。
- 要和伴侣共享记录，进入「设置 → 情侣空间」。一方用开通码创建空间并生成邀请码，另一方输入邀请码加入。配对后，可从共享月历开始记录，也可选择要共享的本机记录。

## 本地运行

安装 Node.js 后，在项目根目录将 `wrangler.example.jsonc` 复制为 `wrangler.jsonc`。创建 `.dev.vars`，写入 `DOI_SETUP_KEY=你的随机开通码`。然后运行下面的 PowerShell 命令。

```powershell
npx.cmd --yes wrangler@4.165.0 d1 migrations apply DB --local
npx.cmd --yes wrangler@4.165.0 pages dev public --ip 127.0.0.1 --port 8742 --r2 ALBUM=doi-local-album
```

打开 [本地预览](http://127.0.0.1:8742/)。可在「设置 → 情侣空间」使用开通码创建测试空间。

## Cloudflare 部署

在 `wrangler.jsonc` 填写自己的 Pages 项目和 D1 数据库配置，通过 Pages Secrets 设置开通码。生产共享相册使用 Backblaze B2 私有存储桶。配置和部署步骤见 [PWA 开发方案](PWA开发方案.md#cloudflare-部署与-iphone-验收)。

# DoI iPhone 网页 App 开发方案

## 第一版目标

本节记录最初的单机版设计。具体用途和业务字段待定，第一版用简单记录验证新增、编辑、删除、离线使用和备份恢复。安装方式为 iPhone 主屏幕网页 App，无需 Apple 开发者会员和 iOS 应用签名。

## 技术和目录

在 Windows 上用 HTML、CSS 和 JavaScript 开发。将可公开的网页文件集中在 `public/`，发布时只上传该目录。

| 计划文件 | 职责 |
| --- | --- |
| `public/index.html`、`public/styles.css` | 手机界面、记录列表和编辑表单 |
| `public/app.js`、`public/db.js` | 界面交互及 IndexedDB 读写 |
| `public/manifest.webmanifest`、`public/icons/` | App 名称、主屏幕图标和独立窗口 |
| `public/sw.js` | 缓存界面文件，让 App 可以离线打开 |

## 数据和离线

- **业务数据**存入 iPhone 的 IndexedDB。示例字段为记录 ID、标题、内容、创建时间和修改时间，业务确定后再调整。写入事务完成后才提示“已保存”。第一版采用单机存储，发布站点只提供静态文件。
- **离线资源**由 Service Worker 按版本缓存，包括页面、样式、脚本和图标。首次从主屏幕图标联网启动时，缓存就绪后再显示“可离线使用”。同一网址发布新版，联网后获取更新。更新资源缓存时保留数据库，字段变化通过数据库版本迁移。 [WebKit 离线缓存](https://webkit.org/blog/8090/workers-at-your-service/)
- **备份**支持把记录手动导出为带格式版本的 JSON，保存到 iPhone 的“文件”App。导入前校验格式，预览新增和跳过的数量，按记录 ID 去重并保留已有记录。校验通过后一次提交，导入失败时保留原数据。换机或本机网页数据被清理后，可用备份恢复。 [WebKit 存储策略](https://webkit.org/blog/14403/updates-to-storage-policy/)
- **正式记录从主屏幕入口开始录入。** Safari 网页里的 IndexedDB 记录不会在添加到主屏幕时自动复制过去。若已经在 Safari 录入，可以从 Safari 导出，再从主屏幕 App 导入。 [WebKit 主屏幕网页 App 存储说明](https://webkit.org/blog/14787/webkit-features-in-safari-17-2/)

## 开发与上线顺序

1. 先在 Windows 浏览器中验证新增、编辑、删除、关闭后重开，以及 JSON 导入和导出。
2. 加入安装配置和离线缓存。将 `public/` 发布到 Cloudflare Pages，使用其免费额度和固定的 `pages.dev` HTTPS 网址。后续更新使用同一个生产网址。 [静态文件上传](https://developers.cloudflare.com/pages/get-started/direct-upload/) · [免费额度](https://developers.cloudflare.com/pages/platform/limits/)
3. 在 iPhone 用 Safari 打开生产网址，选择「共享」→「添加到主屏幕」→ 开启「作为网页 App 打开」→「添加」。从主屏幕图标联网打开，完成缓存后开始录入。 [Apple 安装指南](https://support.apple.com/zh-cn/guide/iphone/iphea86e5236/27/ios/27)

## 真机验收

- [ ] 首次联网缓存完成后，开飞行模式、退出 App 并从主屏幕重新打开，能读取已有记录。
- [ ] 离线新增或修改记录后，退出再打开，确认保存结果。
- [ ] 将 JSON 备份保存到“文件”App，在空的测试环境恢复并核对记录。重复导入不增加重复记录，损坏文件导入不影响已有记录。
- [ ] 在同一网址发布新版，从原主屏幕图标打开，确认新版可用，旧记录可读取，再次断网也能打开。


## iPhone 联机版

使用自己的 Cloudflare Pages 项目和 D1 数据库部署。

源码仍是 iPhone 主屏幕 PWA。Pages 托管 `public/`，`functions/api/` 负责登录、配对和同步，D1 存储共享记录。安卓可复用同一个接口，后续单独做安装和真机适配。

### 本地运行

在项目根目录将 `wrangler.example.jsonc` 复制为 `wrangler.jsonc`。然后创建 `.dev.vars`，填入自己生成的随机开通码，建议使用 32 个随机字节的十六进制字符串。文件内容格式为 `DOI_SETUP_KEY=你的随机开通码`。在 PowerShell 执行：

```powershell
npx.cmd --yes wrangler@4.165.0 d1 migrations apply DB --local
npx.cmd --yes wrangler@4.165.0 pages dev public --ip 127.0.0.1 --port 8742 --r2 ALBUM=doi-local-album
```

浏览器打开 [本地预览](http://127.0.0.1:8742/)，进入「设置 → 情侣空间 → 首次开通」。第二个独立浏览器配置文件用于模拟伴侣。首次开通和首次加入都会显示恢复码，换机时用自己的恢复码登录。邀请码最多使用一次，有效期为 24 小时。会话有效期为 180 天，过期后可用恢复码继续使用。

### Cloudflare 部署与 iPhone 验收

正式站的共享相册使用 Backblaze B2 私有桶，桶名在 `wrangler.jsonc` 的 `B2_BUCKET` 中配置。在 Pages 项目的生产环境添加 `B2_KEY_ID` 和 `B2_APPLICATION_KEY` 两个密钥，值分别为限制到该桶的 Read and Write 应用密钥 ID 和密钥。上面的本地开发命令使用模拟 R2 存储。 [Backblaze 应用密钥](https://www.backblaze.com/docs/cloud-storage-create-and-manage-app-keys) · [Pages 密钥设置](https://developers.cloudflare.com/pages/functions/bindings/#secrets)

1. 在自己的 Cloudflare 账号中创建 Pages 项目和 D1 数据库。填写 `wrangler.jsonc` 中的实际项目名、数据库名和 ID，绑定名使用 `DB`。在 Pages 项目中添加生产 Secret `DOI_SETUP_KEY`。 [Pages 绑定配置](https://developers.cloudflare.com/pages/functions/bindings/)
2. 从项目根目录运行 `npx.cmd --yes wrangler@4.165.0 d1 migrations apply DB --remote`，成功后运行 `npx.cmd --yes wrangler@4.165.0 pages deploy public --project-name YOUR_PAGES_PROJECT --branch main`。将 `YOUR_PAGES_PROJECT` 换成实际项目名。Wrangler 会上传 `public/` 并编译 `functions/`，部署到已有的固定生产网址。 [Pages Functions 部署](https://developers.cloudflare.com/pages/get-started/direct-upload/#functions)
3. 两台 iPhone 在 Safari 打开同一个 HTTPS 地址并添加到主屏幕。从主屏幕打开后再开通或加入。用测试记录验证完整备注同步、断网新增后补传、JSON 导出及解除配对。已有记录如果留在本地预览网址，通过 JSON 备份迁移到生产网址，再逐条选中要共享的旧记录。

视频上限为 500 MB。超过 50 MB 时，页面按 16 MiB 分片写入 B2，每次请求只传一片。部署前执行的 D1 迁移会创建上传状态表。 [Backblaze 分片上传](https://www.backblaze.com/apidocs/b2-upload-part)

共享记录整条写入 D1，接口逐次验证配对身份。双方都能新增，各自可以编辑、删除自己添加的记录。共享和本机月历在应用内切换。解除配对后服务端关闭旧空间的访问，另一台设备联网确认后退出旧共享视图。数据库仍保留旧空间资料供账号管理员管理，用户可在解配前导出共享副本。

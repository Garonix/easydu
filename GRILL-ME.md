# Grill Me Results

Generated: 2026-08-17T06:36:20.693Z

## Plan

当前进度同步还是失败的，也不清楚进度上传的时机和逻辑是什么，调研一下呢

## Shared Understanding

进度同步重新设计：从"实时上传"改为"checkpoint 模式"（关书上传、开书下载），同时将高亮词/替换规则从全局改为按书独立存储。

## Questions and Answers

### 1. 你说的"进度同步还是失败"，具体现象是什么？（上传不生效？恢复不生效？在什么环境测试？）

**Recommended answer:** 本地 python3 -m http.server 启动后用浏览器连 alist.zeges.top/dav 测试；导入书后阅读一段时间，刷新页面再打开书发现进度没有同步回来。或者是：阅读后检查远端 .easydu/xxx.json 发现内容没更新。

**User answer:** _(not recorded)_

**Status:** open

**Notes:** 需要用户描述具体失败现象（上传 vs 下载 vs 双向）和测试环境（本地服务器类型、浏览器是否强制刷新）

### 2. 你说"进度同步还是失败"——具体是什么现象？

**Recommended answer:** 本地 python3 -m http.server 启动后用浏览器连 alist.zeges.top/dav 测试；导入书后阅读一段时间，刷新页面再打开书发现进度没有同步回来。

**User answer:** 因为同一本书，用户在两个不同的设备上阅读时本地可能都有进度，这时候怎么分辨呢？而且即使是新设备，我实际测试时，也没有正确同步进度；相关文件能正确生成，但是阅读进度跟不上；以及我不知道什么时候阅读进度会被上传，所以不知道什么时候退出阅读而进度不丢失

**Status:** resolved

**Notes:** 三个子问题：①双设备冲突策略 ②新设备恢复失败（文件有但进度不对）③上传时机不清晰

### 3. 进度"跟不上"具体是什么意思？（百分比不更新？章节号不变？还是远端文件里的值始终是 0？）你是在哪个地址测试的？

**Recommended answer:** 用 python3 -m http.server 或 npx serve . 启动本地服务后浏览器访问；远端 .easydu 文件能生成，但里面的 pct 始终是 0 或者始终不变。

**User answer:** _(not recorded)_

**Status:** open

**Notes:** 需要知道：①本地服务器类型（是否有缓存问题）②远端文件里 prog 的具体值（pct 是否一直是 0、ch 是否变化）③用户读了多久/翻了几章

### 4. 进度"跟不上"具体是什么意思？（百分比不更新？章节号不变？还是远端文件里的值始终是 0？）你是在哪个地址测试的？

**Recommended answer:** 远端 .easydu 文件能生成，但里面的 pct 始终是 0 或者始终不变。

**User answer:** 远端文件能生成，但进度值不更新；测试时用 python3 -m http.server 本地启动；读了大概十几分钟，翻了几章。

**Status:** resolved

**Notes:** 关键：读了十几分钟翻了几章但远端进度不更新。这说明 saveProg 的 pct 保存和 flushDavSync 的上传链路有问题。怀疑：①saveProg 被 guard/restoreUntil 持续阻塞 ②saveProg 的内容比较跳过了有效保存 ③flushDavSync 被 _davPullPending 持续阻塞

### 5. 调研发现 saveProg 被 guard/restoreUntil 机制阻塞，导致打开书后的阅读进度不保存也不上传。你实际测试时，是在打开书后多久开始读的？是立刻开始读，还是等了几秒？

**Recommended answer:** 打开书后立刻开始读（1-2秒内），读了十几分钟翻了几章，然后退出阅读检查远端文件。

**User answer:** _(not recorded)_

**Status:** open

**Notes:** 如果用户在 guard 窗口内（1.5-6秒）开始读，早期的翻页/滚动会触发 saveProg 但被 guard 拦截。guard 过期后的翻页应该正常保存。需要确认：用户翻了几章后 pct 是否变化（pct 基于全书百分比，大书的同一章内 pct 可能一直是 0）

### 6. 调研发现 saveProg 被 guard/restoreUntil 机制阻塞，导致打开书后的阅读进度不保存也不上传。你实际测试时，是在打开书后多久开始读的？

**Recommended answer:** 打开书后立刻开始读（1-2秒内）

**User answer:** 打开书后立刻开始读

**Status:** resolved

**Notes:** 用户在 guard 窗口内开始读。但 guard 窗口只有 ~2.5s（settle+1.5s），restoreUntil 是 6s。6s 后 saveProg 正常。用户读了10分钟——之后的翻页应该正常保存。需要确认：①浏览器缓存问题（http.server 可能缓存旧 script.js）②saveProg 的 pct 比较是否导致跳过保存 ③flushDavSync 的 PUT 是否真的到达服务器

### 7. 你的测试浏览器有没有强制刷新？（python3 -m http.server 可能缓存旧 script.js）

**Recommended answer:** 没有强制刷新，用的是 python3 -m http.server 默认配置，浏览器可能缓存了旧代码。

**User answer:** _(not recorded)_

**Status:** open

**Notes:** 这是最可能的根因——之前的 debug 反复证明浏览器缓存会导致 pull/guard 等新代码不生效。建议换 npx serve --no-cache 或 npx http-server -c-1 并 Ctrl+Shift+R 强刷

### 8. （技术文档性回答）进度上传时机是什么？

**Recommended answer:** scroll→afterScroll(800ms)→saveProg→scheduleDavSync(3s)→flushDavSync→PUT。被 guard(2.5s)/restoreUntil(6s)/内容未变 三种情况阻塞。

**User answer:** （自动记录——文档性回答，不需要用户选择）

**Status:** resolved

**Notes:** 上传链路已梳理清楚，用户已知悉

### 9. 两个设备都有进度时，你期望的行为是什么？

**Recommended answer:** 较新的进度为准——自动取最后修改时间更新的一方，用户无需选择。

**User answer:** 较新的进度为准

**Status:** resolved

**Notes:** 用户选择自动取较新一方。当前代码尝试这么做（L vs R 时间戳比较），但 bug 是打开书的自动保存把本地 ts 污染成"现在"，导致本地永远看起来比远端新。修复方向：L 的计算应排除"打开书自动保存"的 ts（用 _davOpenTs 过滤）。

### 10. 修复方向：saveProg 始终本地保存 + guard 只控制上传 + 冲突用用户真实修改时间。你认同吗？

**Recommended answer:** 认同，就这么修。

**User answer:** 需要简化

**Status:** resolved

**Notes:** 用户觉得当前设计太复杂，需要简化。考虑"极简同步"方案：去掉所有 guard/restoreUntil/pullPending/contentCompare，用最简单的逻辑。

### 11. 极简方案能满足需求吗？（远端打开时总是赢）

**Recommended answer:** 可以，就这样。

**User answer:** 这个方案的前提是本地进度能一直上传到远端，但是为了一个阅读进度同步实时消耗资源感觉又很亏，因为本项目本质上是想打造一个离线阅读器

**Status:** resolved

**Notes:** 关键洞察：项目本质是离线阅读器，不应实时上传。应该只在"关书"和"开书"时同步，阅读中只保存本地。

### 12. "关书上传、开书下载"的 checkpoint 模式是否满足需求？

**Recommended answer:** 满足，就这样做。

**User answer:** 点击主页按钮或者返回时，弹窗提示是否上传进度即可。开书时，静默检测远端进度，如果大于当前本地进度，就弹窗提示，是否跳到云端进度

**Status:** resolved

**Notes:** 用户进一步细化了交互：关书时弹窗确认上传；开书时静默检测远端，远端进度>本地则弹窗问是否跳转。更符合用户控制权。

### 13. "远端进度大于本地"怎么判断？

**Recommended answer:** 章节+百分比：远端ch更大，或ch相同时pct更大，视为远端更前。

**User answer:** 章节+百分比

**Status:** resolved

**Notes:** 比较逻辑：remote.ch > local.ch || (remote.ch === local.ch && remote.pct > local.pct) → 弹窗提示是否跳转

### 14. 关书上传时同步哪些内容？

**Recommended answer:** 全部（进度+书签+划线+标签）

**User answer:** 同步所有。而且还需要修复之前的一个逻辑，之前把"内容替换"和"文本高亮"功能做成了全局保存，影响所有书，但我认为这俩功能是根据不同的书需要单独保存的，每本书独有

**Status:** resolved

**Notes:** 重大新需求：高亮词(jd_hl)和替换规则(jd_rep)从全局改为按书独立存储。需要：①数据模型变更（jd_hl→jd_hl_<name>，jd_rep→jd_rep_<name>）②迁移旧全局数据 ③同步范围扩展（每书独立的 hl/rep 也一起同步）

### 15. 现有全局高亮词/替换规则数据怎么迁移？

**Recommended answer:** 全部书都继承——现有全局 hl/rep 作为默认值，每本书第一次打开时自动继承。

**User answer:** 直接丢弃

**Status:** resolved

**Notes:** 最简方案：丢弃现有全局 jd_hl/jd_rep 数据，每本书从空开始。不需要迁移逻辑。

### 16. （综合确认）完整的同步设计方案已明确：checkpoint 模式 + hl/rep 按书独立 + 丢弃旧全局数据。还有其他需要确认的吗？

**Recommended answer:** 方案已明确，可以保存并开始实现。

**User answer:** _(not recorded)_

**Status:** open

**Notes:** 设计方案汇总：①hl/rep 按书独立（jd_hl_<name>/jd_rep_<name>），丢弃旧全局数据 ②checkpoint 同步（关书弹窗确认上传，开书静默检测+弹窗跳转）③同步范围：全部（prog+bm+ant+cat+hl+rep）④进度比较：ch+pct ⑤去掉所有 guard/restoreUntil/pullPending ⑥saveProg 始终本地保存 ⑦只有一个 .easydu/<name>.json，无 _global.json

### 17. 删除书时要同步删除远端配置吗？

**Recommended answer:** 是，同步删除。失败时提示。

**User answer:** 是，同步删除

**Status:** resolved

**Notes:** deleteBook 时 DELETE .easydu/<name>.json，失败 toast 提醒

## Agreed Decisions

- 同步模型：checkpoint 模式——阅读中只存本地，关书时上传，开书时下载
- 关书上传：点击主页/返回按钮时弹窗确认"是否上传进度"，用户确认后上传
- 开书下载：静默检测远端，若远端进度（ch+pct）大于本地则弹窗"是否跳到云端进度"
- 同步范围：全部（进度+书签+划线+标签+高亮词+替换规则）
- 高亮词(jd_hl)和替换规则(jd_rep)从全局改为按书独立：jd_hl_<书名>/jd_rep_<书名>
- 现有全局 jd_hl/jd_rep 数据直接丢弃，每本书从空开始
- 进度比较：远端 ch>本地 ch，或 ch 相同且 pct 更大，视为远端更前
- 去掉所有 guard/restoreUntil/pullPending/contentCompare 机制，大幅简化代码
- saveProg 始终保存本地（无阻塞），上传只在关书时触发
- 远端文件结构：.easydu/<书名>.json（每书一个文件，无 _global.json）
- 删除书时同步 DELETE 远端配置，失败 toast 提醒

## Open Risks

- 关书弹窗可能打断用户体验（考虑加"不再提醒"选项或记住选择）
- 浏览器直接关闭/杀进程时 beforeunload 的上传可能来不及完成
- 按书独立 hl/rep 后，用户切换书时设置面板需要重新加载对应书的配置
- 旧全局 hl/rep 数据丢弃后用户可能需要重新配置

## Next Decision Needed

开始实现前确认是否需要"记住用户选择"（关书时不再弹窗直接上传/不上传）

# 交接清理与保留清单

日期：2026-11-08（Asia/Shanghai）。服务器清理已完成；本机删除被自动审批拦截，以下状态明确区分。

## 已完成的服务器清理

- 清理 48 个经过路径、inode、活动任务和运行目录检查的目标：14 个过期/失败构建、两处已完成构建的暂存源码目录、开发测试 .tmp、安装下载和 uv 缓存，以及 29 个明确的临时脚本、发布包、清单、日志或无效备份文件。
- 删除已合并、工作区干净的 github-initialization 一次性 Git 工作区及本地辅助分支。保留 main、成员任务分支和成员任务工作区，未操作 GitHub 远程分支。
- 文件逻辑大小合计 6,534,474,383 字节；磁盘实际新增可用空间 6,479,777,792 字节，约 6.0 GiB。清理后可用 9,553,719,296 字节，df 显示约 8.9 GiB、使用率 85%；清理前约 2.9 GiB、95%。
- 当前 .next（BUILD_ID=gVzkJwfIn5nBMKswunIzN）及前一版 .next-before-git-sync-20261108T093232Z 均保留；node_modules、生产 Python .venv、运行时、真实配置、数据库、Git 仓库、证书及历史有效备份均保留。
- 清理后 Web、MCP、MySQL 和证书续期 timer 全部 active，首页 HTTP 200。本轮没有重启服务、迁移数据库或发起真实模型/搜索调用。

## 备份修正

检查发现此前两个 source-before-git-sync 压缩包只有 45 字节、没有源码，不能作为有效回滚依据。本次先生成并校验有效当前源码/数据库/配置/Git 快照，保留与前一构建对应的完整源码包，再删除空包和空清单。

有效备份目录：/home/ubuntu/scenarioforge/deploy/private/backups/handoff-20261108T095944Z。目录 0700、文件 0600；SHA256SUMS 已核验。私有配置和仓库备份包含敏感信息，仅保留服务器，不进入普通源码交付包。压缩完整性检查不等于实际恢复演练。

## 本机仍需手动清理

批量删除以及缩小为仅删除 .next 的请求均被自动审批拒绝，工具只返回 blocked by policy，没有更详细原因；两次删除均未执行。没有更换工具或通过其他方法绕过限制。

以下已确认可清理项仍在原位置，总计约 1.6 GiB，用户可在确认本地开发服务器停止后通过文件资源管理器删除：

- D:\5\ScenarioForge-main\.next：本机生成的开发/构建缓存。
- D:\5\ScenarioForge-main\.tmp：旧发布包、一次性脚本、下载缓存、测试虚拟环境和临时测试配置。验收截图已复制归档到 docs/evidence；旧测试库和账号已失效且确认不存在。
- D:\5\ScenarioForge-main\test-results、tsconfig.tsbuildinfo、mcp-server\__pycache__、mcp-server\tools\__pycache__、scripts\__pycache__（存在时）：可再生成的测试输出和编译缓存。
- D:\5\scenarioforge-deepseek-search.tar.gz：已经部署且服务器保留历史源码备份的旧发布包。

保留本机源码、node_modules、.env.local、D:\5\java.pem、D:\5\mysql-connection、原始需求 PDF、delivery 交付目录和 docs/evidence。源码交付包采用明确文件选择，上述缓存、真实配置、密钥、数据库内容均不在包中。

## 交付核验

- 147 个业务源码、数据库 schema/迁移及关键运行配置文件的 SHA-256 与生产服务器逐一比较，差异为零。
- 浏览器上次回归记录 passed、失败列表为空；Git 集成测试历史日志 fail 0 已保存在服务器备份内。本次不重复收费模型测试或全量回归。
- 验收截图从临时目录归档到 docs/evidence，涉及邀请码的页头已遮盖；测试截图与真实生产截图在该目录 README 中区分。
- 交付包根目录 SHA256SUMS.txt 记录所有文件哈希，外部同名 .zip.sha256 校验压缩包。打包过程检查禁止文件、凭据模式、ZIP CRC 和逐文件哈希；交付说明与完整历史均包含在包内。

逐项服务器删除记录、本机被阻止状态和源码比对清单位于交付包 records 目录。未做数据库恢复演练、全新机器重装或额外真实模型验收。

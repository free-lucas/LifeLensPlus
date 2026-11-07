方式 1：单次启动命令行参数（推荐，只对本次会话生效）
方案 A：最简一键全开（彻底关闭沙箱 + 全部自动审批）
powershell
codex --dangerously-bypass-approvals-and-sandbox
等价于：关闭沙箱隔离 + approval_policy=never，所有操作完全不弹窗确认，任意命令直接执行。
方案 B：保留沙箱边界，只取消弹窗（更推荐日常开发，相对安全）
只自动批准工作区内所有操作，限制只能操作当前项目目录，不会随便跑到系统目录乱改文件：
powershell
codex --ask-for-approval never --sandbox workspace-write
还需要网络访问（比如调用本地 ollama 11434 接口），搭配：
powershell
codex --ask-for-approval never --sandbox workspace-write -c sandbox_workspace_write.network_access=true
--ask-for-approval never：永远不弹出审批确认
workspace-write：只能读写当前项目文件夹，可开启网络访问，不能随意访问系统其他目录
方式 2：修改全局 config.toml（永久生效，所有 codex 会话）
Windows 路径：%USERPROFILE%\.codex\config.toml
① 完全无限制模式（全部权限，不推荐长期默认）
toml
approval_policy = "never"
sandbox_mode = "danger-full-access"
② 日常推荐：工作区自动执行（仅当前项目目录可读写，带网络）
toml
approval_policy = "never"
sandbox_mode = "workspace-write"
[
sandbox_workspace_write
]
network_access = true
配套开启自动应用代码补丁（自动写文件，不再询问）
toml
[
editing
]
apply_patches_automatically = true
审批策略选项说明
never：全部自动执行，不再弹窗询问
untrusted（默认）：只读操作自动执行；修改文件 / 执行高危命令需要你确认
on-request：任何超出沙箱范围的动作，都会弹框等待你手动批准
交互式会话内临时切换（已经进入 codex 之后）
在 codex 终端直接输入指令，无需重启：

## lancedb
docker run --rm -p 8080:8080 --mount type=bind,source="C:/Users/Administrator/AppData/Roaming/lifelens-plus/lancedb",target=/data ghcr.io/lance-format/lance-data-viewer:lancedb-0.36.0


## gitnexus
codex安装：
codex mcp add gitnexus -- npx -y gitnexus@latest mcp
查看安装：
codex mcp list | grep gitnexus
进入项目更目录初始化
npx gitnexus@latest analyze
启动服务查看：
npx gitnexus@latest serve
打开http://localhost:4747

node .gitnexus/run.cjs analyze --index-only

## sqlite
docker run -d --name lifelens-live -p 8082:8080  -v "C:\Users\Administrator\Pictures\LifeLensPlus:/data:ro" coleifer/sqlite-web sqlite_web -H 0.0.0.0 -p 8080 -r -x -T -R 100 /data/lifelens.db

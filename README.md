# solo-6600001 - 在线协作白板应用

## 项目简介
构建一个在线协作白板应用，支持多人实时绘图、便签、形状工具，具备画布缩放/平移、图层管理、实时光标显示、导出为PNG/PDF功能，使用WebSocket实现多人同步

## 技术栈
- **前端**: React + TypeScript + Canvas API + Zustand
- **后端**: Node.js + Express + Socket.io
- **数据库**: MongoDB

## 快速开始

### 一条命令统一启动前后端（推荐）

在项目根目录执行：

```bash
npm run dev        # 等价于 ./scripts/dev.sh up
```

脚本会按顺序完成：

1. **清理旧进程** —— 自动回收本项目遗留的 nodemon / vite 进程（含手工启动的），不碰无关程序，避免端口占用和重复连接
2. **依赖准备** —— 已安装且校验通过则跳过（不重复安装）；检测到跨平台拷来的损坏 `node_modules`（如缺 rollup 原生包）会自动删除并按 lockfile 重装
3. **启动服务端** —— 会议纪要与业务流程服务（:3001），等待健康检查就绪
4. **启动画板前端** —— Vite（:5173），等待页面就绪
5. **端到端检查** —— 页面可达、`/api` 代理、模板数据、`/socket.io` WebSocket 握手逐项验证
6. 输出最终访问入口：**http://localhost:5173/**

任一步失败都会明确打印**失败环节、原因和修复建议**（依赖安装日志、就绪超时、端口占用等），修好后直接重跑同一条命令即可。

其他命令：

```bash
npm run check     # 只做端到端检查（服务已在运行时复测用）
npm run status    # 查看前后端进程状态
npm run stop      # 停止并回收整个进程组，不留旧进程
npm run restart   # 停止后重新走完整启动流程
npm run logs      # 查看日志（npm run logs -- server -f 实时跟踪）
```

运行期 pid 与日志位于 `.dev/`（已加入 .gitignore）。也可直接运行 `./scripts/dev.sh <up|check|status|stop|restart|logs>`。

### 手工分别启动（保持可用）

需要单独调试某一端时，原有方式不变：

#### 服务端
```bash
cd server
npm install
npm run dev
```

#### 客户端
```bash
cd client
npm install
npm run dev
```


## 功能特性
- 多人实时协作绘图
- 画笔、矩形、圆形、直线、文本工具
- 便签功能
- 图层管理（新建、可见性、锁定）
- 实时光标显示
- 画布缩放/平移
- WebSocket实时同步

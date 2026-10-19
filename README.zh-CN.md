# pi-antigravity-unmask

[English README](README.md)

[Pi coding agent](https://github.com/earendil-works/pi) 扩展:拦截 `pi-antigravity` provider 流式中途的

```
Error: Provider stopped with: PROHIBITED_CONTENT
```

Antigravity 后端截断回复时,已流出的部分内容默认会**被整个丢出会话**(pi-antigravity 构造下一条请求时会跳过 `stopReason: "error"` 的 assistant 消息),且本轮 agent 直接失败。本扩展把这类截断当作正常 finish 处理:已产出内容保留进上下文,回复从截断处自动无缝续写。

是 [pi-antigravity](https://github.com/Rahularya01/pi-antigravity) 的伴生扩展——只包装、不改动它,provider 升级永不冲突。

## 工作原理

- `session_start` 时读取 pi-antigravity 已注册的 `streamSimple`,以包装后的副本重新注册 provider。Pi 的 `registerProvider` 按字段合并,只替换 stream handler——models、OAuth 账号、模型刷新全部保持原样。
- 流健康期间所有事件原样透传,零开销。
- 命中拦截名单的 `error` 事件(`rawStopReason` 匹配配置项)到达时:已累积的 partial 消息被降级为正常 assistant 轮(剥掉 error 字段使其能进入后续请求),附一条简短 user 续写指令后重新请求。
- 续写增量经 contentIndex 重映射并入同一条消息——续写文本接进尾部 text block,界面上看到的就是同一条回复继续生长。各段 usage 自动累加。
- 最终以正常 `done` 事件收尾,agent 循环如同无事发生般继续。

## 安装

需要已安装并登录 [pi](https://github.com/earendil-works/pi) 与 [pi-antigravity](https://github.com/Rahularya01/pi-antigravity) provider。

```bash
pi install npm:pi-antigravity-unmask
```

重启 pi(或开新会话),执行以下命令确认:

```
/unmask.status
```

预期输出:

```
provider=antigravity
registered=yes
wrapActive=true
stops=PROHIBITED_CONTENT
maxContinuations=5
```

## 配置

| 环境变量 | 默认值 | 含义 |
|---|---|---|
| `PI_UNMASK_STOPS` | `PROHIBITED_CONTENT` | 逗号分隔的拦截名单(如追加 `SAFETY`)。 |
| `PI_UNMASK_MAX_CONTINUATIONS` | `5` | 每条响应最大自动续写请求次数。 |

## 行为边界

- 截断处已含 toolCall 的消息**不**自动续写(重发请求容易导致重复调用);按正常 finish 收尾,交给常规工具流程。
- 连续两次零输出的尝试即停止重试并透出原始错误——那说明请求本身被硬拦,而非流中截断。
- 非名单内的失败(网络、配额、认证)与 abort 原样透传,不吞。
- 重复 `session_start`(resume、reload)不会叠加包装。

## 开发

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # 19 项断言:透传、拼接、重映射、usage、幂等、额度
```

测试套件通过 jiti 加载 TS 扩展本体、对接真实 `pi-ai` 事件流实现——无需启动 pi 进程。

## 许可

[MIT](LICENSE)

# Longbridge 公开 OAuth 元数据兼容性诊断

日期：2026-11-24（Asia/Shanghai）。范围为源码只读检查及已完成的四次公开、无凭证 GET；未读取本机凭证、OAuth 缓存、账户或私人历史，未发起授权、模型、测试、GUI 或构建。

## 已观察到的公开响应

以下为本次公开请求返回的字段，不是账户响应；不代表实际安装态使用了同一份发现缓存。

| 精确公开 URL | 响应及已观察字段 |
| --- | --- |
| `https://mcp.longbridge.com/.well-known/oauth-authorization-server` | HTTP 200，`application/json`；`issuer=https://mcp.longbridge.com`；`authorization_endpoint=https://mcp.longbridge.com/oauth2/authorize`；`token_endpoint=https://mcp.longbridge.com/oauth2/token`；`registration_endpoint=https://openapi.longbridge.com/oauth2/register`；`scopes_supported=["4","6","10","11"]` |
| `https://mcp.longbridge.com/.well-known/oauth-protected-resource/v2` | HTTP 200，`application/json`；`resource=https://mcp.longbridge.com/v2`；`authorization_servers=["https://mcp.longbridge.com"]`；`scopes_supported=["4","6","10"]` |
| `https://mcp.longbridge.com/.well-known/oauth-protected-resource` | HTTP 200，`application/json`；`resource=https://mcp.longbridge.com`；`authorization_servers=["https://mcp.longbridge.com"]`；`scopes_supported=["4","6","10","11"]` |
| `https://mcp.longbridge.com/v2/.well-known/oauth-authorization-server` | HTTP 401；未据此推断账户或授权状态 |

官方说明页面为 `https://open.longbridge.com/docs/mcp`、`https://open.longbridge.com/docs/mcp/authorization` 与 `https://open.longbridge.com/docs/mcp/setup`。当时页面标示 2026-11-11 更新，公开推荐主端点 `https://mcp.longbridge.com`；页面本身没有提供授权主机白名单，不能单凭该说明替换应用的 `/v2` 只读端点。

## 源码定位与确定行为

- `desktop/src/mcp/oauth-provider.mjs:90` 的 `redirectToAuthorization()` 检查 HTTPS，并在第 93 行将唯一允许的主机固定为 `openapi.longbridge.com`。第 95 行抛出精确错误 `Rejected an unexpected Longbridge authorization URL.`。`6 10` 权限检查在此之后，使用另一条错误消息。
- SDK 1.32.2 的 `desktop/node_modules/@modelcontextprotocol/sdk/dist/esm/client/auth.js` 中，`startAuthorization()` 在存在元数据时直接采用 `metadata.authorization_endpoint`；没有元数据时才回退到授权服务器下的 `/authorize`。
- `desktop/src/mcp/longbridge-client.mjs:141` 的 `onRedirect` 在非交互模式下拒绝授权。provider 的域名检查先于该回调，因此自动恢复也可能呈现上述域名拒绝消息。
- `desktop/main.mjs:457` 的启动路径会在存在保存授权时调用 `longbridge.connect({ interactive: false })`，连接失败经状态通道显示。

## 推断与未知

公开元数据给出的新授权 URL 主机为 `mcp.longbridge.com`。SDK 按该字段构造 URL 后，当前只允许 `openapi.longbridge.com` 的检查必然拒绝，因而存在可独立复核的公开兼容缺口。发现、动态注册、浏览器授权分别使用不同端点；不能将仍为 `openapi.longbridge.com` 的注册端点当成浏览器授权主机的证据。

**本机被拒绝的实际 URL 未读取。** 本机发现缓存、实际采用的元数据及本次启动中凭证路径也未读取；因此不能将公开兼容缺口直接等同于本次安装态错误的完整根因，不能宣称真实长桥 OAuth 已修复或验收。现有拒绝行为保持了安全边界。

## 下一独立修复范围

后续单独核验官方授权主机与精确路径契约，再考虑受约束的允许规则；保留 `/v2`、显式 `6 10` 权限、issuer 绑定、旧无绑定凭证的拒绝、代际隔离、系统代理及跨源重定向防护。不采用泛域名放行、不切换到可能暴露写工具的根端点、不直接删除旧授权，也不因公开元数据列出其他 scope 而申请它们。以隔离合成回归验证允许和拒绝路径；真实 OAuth 另行明确范围后验收。

本轮用户选择 IBKR；本次不重授权长桥，不扩大到账户或私人历史读取，也不为该旁路问题重复安装态模型 case。

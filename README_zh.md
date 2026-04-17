# meta-lc-runtime-angular

[English](./README.md) | 中文

## 定位
Angular 运行时接入层，负责通过 BFF-only 数据路径进行 schema 渲染与数据绑定。

## 里程碑映射
- 主里程碑：Phase 4
- 主线看板：[GitHub Project #5](https://github.com/orgs/zhongmiao-org/projects/5)

## 职责边界
- In-scope：承接 Meta-Driven SaaS OS 主线对应模块职责。
- 依赖关系：消费 core 契约与 bff 数据契约。
- Non-goal：不允许直连后端/数据库。

## MUST 约束
- DSL 是唯一真相。
- 所有数据/实时链路必须经过 BFF。
- Runtime 不承载业务规则实现。
- Meta Kernel 是唯一结构来源。

## 协作说明
- Phase 5（Designer）与 materials 保持在   [ngx-lowcode](https://github.com/zhongmiao-org/ngx-lowcode) 基础库。
- [ngx-puzzle](https://github.com/zhongmiao-org/ngx-puzzle) 继续作为独立基础库。

## 快速开始
克隆后：
```bash
npm ci
npm run build
npm run test -- --watch=false
```

后续接入实现包后：
```ts
import { provideHttpClient } from '@angular/common/http';
import { NGX_LOWCODE_DATASOURCE_MANAGER, NGX_LOWCODE_WEBSOCKET_MANAGER } from '@zhongmiao/ngx-lowcode-core-types';
import { createBffDataSourceManager, createDefaultWebSocketManager } from '@zhongmiao/meta-lc-runtime-angular';

export const appConfig = {
  providers: [
    provideHttpClient(),
    {
      provide: NGX_LOWCODE_DATASOURCE_MANAGER,
      useValue: createBffDataSourceManager({
        baseUrl: 'http://localhost:6000'
      })
    },
    {
      provide: NGX_LOWCODE_WEBSOCKET_MANAGER,
      useValue: createDefaultWebSocketManager()
    }
  ]
};
```

## 参考
- 统一文档仓库：[lowcode-docs](https://github.com/zhongmiao-org/lowcode-docs)
- 架构基线：[Meta-Driven Standard](https://github.com/zhongmiao-org/lowcode-docs/blob/main/meta-driven-standard_zh.md)

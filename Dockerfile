# syntax=docker/dockerfile:1
#
# 独立版 Web 服务的镜像：部署到服务器，从别的机器用浏览器访问。
#
# 构建：docker buildx build --platform linux/amd64,linux/arm64 .（CI 见 .github/workflows/docker.yml）
# 运行：见 README「Docker 部署」。必须给 NOVELFORGE_TOKEN——镜像里绑 0.0.0.0，没令牌服务拒绝启动。
#
# 两段：
# 1) 构建段**固定跑在构建机的架构上**（--platform=$BUILDPLATFORM），由 Bun 交叉编译出目标架构的
#    单文件可执行。两个架构都不经 QEMU 模拟——和 release.yml 在 Linux 上编 Windows .exe 是一个办法。
# 2) 运行段只放那一个文件。distroless/cc：有 glibc（Bun 单文件要）、CA 证书（调模型的 HTTPS 要）
#    与时区数据，没有 shell 与包管理器；整段没有 RUN，所以 arm64 那份也不用模拟。

# 必须是带 --platform 的命名阶段：直接 `COPY --from=oven/bun:1` 拉的是**目标**架构的 bun，
# 在构建机上跑不起来。
FROM --platform=$BUILDPLATFORM oven/bun:1 AS bun

FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS build
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /src
# 先只拷依赖清单：只改源码时这一层吃缓存，不必重装依赖。
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# 前端产物、内嵌资源与版本号与架构无关，放在 TARGETARCH 之前，两个架构共用这一层。
RUN node scripts/embed-media.js && mkdir -p /out/data
ARG TARGETARCH
# amd64 用 baseline：默认那版要求 CPU 支持 AVX2，NAS 上常见的赛扬一类没有，一跑就是 Illegal instruction。
RUN case "$TARGETARCH" in \
      amd64) target=bun-linux-x64-baseline ;; \
      arm64) target=bun-linux-arm64 ;; \
      *) echo "不支持的架构：$TARGETARCH" >&2; exit 1 ;; \
    esac \
 && bun build src/shells/standalone/main.ts --compile --target="$target" --outfile /out/novelforge

# :nonroot 以 uid 65532 运行。挂宿主目录时先 `chown -R 65532:65532` 那个目录。
FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /out/novelforge /usr/local/bin/novelforge
# 配置与 API Key 在 $HOME/.novelforge，书也放在这下面：一个卷全装下。
COPY --from=build --chown=65532:65532 /out/data /data
ENV HOME=/data
WORKDIR /data
VOLUME /data
EXPOSE 3680
ENTRYPOINT ["/usr/local/bin/novelforge", "--host", "0.0.0.0", "--no-open"]

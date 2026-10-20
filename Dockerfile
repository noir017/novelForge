# syntax=docker/dockerfile:1
#
# 独立版 Web 服务的镜像：部署到服务器，从别的机器用浏览器访问。
#
# 构建：docker buildx build --platform linux/amd64,linux/arm64 .（CI 见 .github/workflows/docker.yml）
# 运行：见 README「Docker 部署」。必须给 NOVELFORGE_TOKEN——镜像里绑 0.0.0.0，没令牌服务拒绝启动。
#
# 两段：
# 1) 构建段**固定跑在构建机的架构上**（--platform=$BUILDPLATFORM），由 Bun 交叉编译出目标架构的
#    单文件可执行。编译不经 QEMU 模拟——和 release.yml 在 Linux 上编 Windows .exe 是一个办法。
# 2) 运行段：debian-slim，放那一个文件，外加 git 与 ssh——作者在容器里用 git 同步书
#    （`docker compose exec novelforge git -C /data/<书> pull`）。Novel Forge 自己不碰 `.git`：
#    app 里的版本管理是它自己的存档点，git 只是作者自己的同步工具。
#    从前是 distroless/cc（没有 shell 与包管理器，装不了 git）；换成 slim 之后运行段有一条 RUN，
#    arm64 那份的 apt 要经 QEMU 模拟（docker.yml 里的 setup-qemu-action），只有这一层。

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

# 以 uid 65532 运行（与从前 distroless:nonroot 同一个号，已经 chown 过的宿主目录不用重来）。
# 挂宿主目录时先 `chown -R 65532:65532` 那个目录。
# ca-certificates：调模型的 HTTPS 与 git 的 https 远端都要；tzdata：TZ 环境变量要；less：git log 的分页。
FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tzdata git openssh-client less \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 65532 nonroot \
 && useradd --uid 65532 --gid 65532 --home-dir /data --no-create-home --shell /bin/bash nonroot
COPY --from=build /out/novelforge /usr/local/bin/novelforge
# 配置与 API Key 在 $HOME/.novelforge，书也放在这下面：一个卷全装下。git 的身份（.gitconfig）与 SSH 密钥（.ssh/）
# 也落在 $HOME，同样在卷里。
COPY --from=build --chown=65532:65532 /out/data /data
ENV HOME=/data
USER 65532:65532
WORKDIR /data
VOLUME /data
EXPOSE 3680
ENTRYPOINT ["/usr/local/bin/novelforge", "--host", "0.0.0.0", "--port", "3680", "--no-open"]

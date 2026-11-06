FROM alpine:3.21.3

# The base image is pinned; apk packages are intentionally NOT pinned to exact
# revisions. Alpine drops superseded revisions from its index, so exact pins stop
# resolving on their own schedule and break the build (and the Coolify deploy).
# Packages stay on the Alpine 3.21 branch (and postgresql17-client on major 17).
RUN apk add --no-cache --upgrade \
    bash \
    ca-certificates \
    coreutils \
    findutils \
    gzip \
    postgresql17-client \
    util-linux \
    aws-cli \
    supercronic \
    tini

RUN addgroup -g 1000 backup && \
    adduser -u 1000 -G backup -s /bin/bash -D backup && \
    mkdir -p /backups/postgres && \
    chown -R backup:backup /backups

COPY --chown=backup:backup scripts/ /usr/local/bin/
RUN chmod +x /usr/local/bin/*.sh

USER backup
ENV HOME=/home/backup

HEALTHCHECK --interval=1m --timeout=5s --start-period=30s --retries=3 \
    CMD ["/usr/local/bin/healthcheck.sh"]

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/scheduler.sh"]

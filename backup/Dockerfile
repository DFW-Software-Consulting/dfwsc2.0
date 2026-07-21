FROM alpine:3.21.3

# Pin tool versions discovered on Alpine 3.21.3.
# Refresh with: docker run --rm alpine:3.21.3 sh -c "apk update >/dev/null && apk search -x <pkg>"
RUN apk add --no-cache --upgrade \
    bash=5.2.37-r0 \
    ca-certificates=20260413-r0 \
    coreutils=9.5-r2 \
    findutils=4.10.0-r0 \
    gzip=1.13-r0 \
    postgresql17-client=17.10-r0 \
    util-linux=2.40.4-r1 \
    aws-cli=2.22.10-r0 \
    supercronic=0.2.33-r5 \
    tini=0.19.0-r3

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

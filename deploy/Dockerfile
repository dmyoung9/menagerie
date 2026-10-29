# Build the reviewed wheel/sdist and prepare release inputs before building.
FROM ghcr.io/astral-sh/uv:0.13.6@sha256:af22a52f5eafef3d78e551599d405c02df61919d18028f0cea8eda93bc9986d0 AS uv
FROM ubuntu:24.04@sha256:24737cef17f4e22b1977df7d9a05e77c4e28b7da5b8911f8d8ccda136bf3573c
ARG VERSION
ARG REVISION=unknown
LABEL org.opencontainers.image.title="Menagerie" \
      org.opencontainers.image.source="https://github.com/dmyoung9/menagerie" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates python3 python3-venv libgomp1 libcurl4t64 tini \
    && rm -rf /var/lib/apt/lists/*
COPY --from=uv /uv /usr/local/bin/uv
COPY dist/menagerie-${VERSION}-py3-none-any.whl /tmp/application.whl
COPY dist/menagerie-${VERSION}-requirements.txt /tmp/requirements.txt
COPY dist/menagerie-${VERSION}.tar.gz /usr/share/menagerie/source.tar.gz
COPY LICENSE /usr/share/menagerie/LICENSE
RUN python3 -m venv /opt/menagerie \
    && mv /tmp/application.whl /tmp/menagerie-${VERSION}-py3-none-any.whl \
    && uv pip install --no-cache --python /opt/menagerie/bin/python \
         --constraint /tmp/requirements.txt /tmp/menagerie-${VERSION}-py3-none-any.whl \
    && rm /tmp/menagerie-${VERSION}-py3-none-any.whl /tmp/requirements.txt \
    && mkdir /data && chown 1000:1000 /data
COPY deploy/entrypoint.sh /usr/local/bin/menagerie-container
RUN chmod 755 /usr/local/bin/menagerie-container
ENV PATH="/opt/menagerie/bin:${PATH}" HOME=/data MENAGERIE_STATE=/data \
    XDG_CACHE_HOME=/data/cache UV_CACHE_DIR=/data/cache/uv \
    UV_PYTHON_INSTALL_DIR=/data/python MENAGERIE_PORT=8017 MENAGERIE_GATEWAY_PORT=8001 \
    PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 MENAGERIE_CONTAINER=1
USER 1000:1000
WORKDIR /data
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c 'import os,urllib.request; urllib.request.build_opener(urllib.request.ProxyHandler({})).open("http://127.0.0.1:"+os.environ["MENAGERIE_PORT"]+"/health",timeout=3).close()'
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/menagerie-container"]

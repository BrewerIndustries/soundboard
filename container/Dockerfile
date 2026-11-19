# YouTube clip extractor for the Soundboard Worker.
#
# Base: the bgutil PO-token provider image (Node + its compiled server), because
# yt-dlp needs PO tokens to be allowed to stream from non-home IPs. On top of it:
# Python + yt-dlp[default] (with yt-dlp-ejs) + ffmpeg + the tiny HTTP service.
FROM docker.io/brainicism/bgutil-ytdlp-pot-provider:2.0.2

USER root

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Pin yt-dlp: extractors move fast and we want deploys to be reproducible.
RUN python3 -m venv /opt/yt-dlp \
 && /opt/yt-dlp/bin/pip install --no-cache-dir \
      "yt-dlp[default]==2026.10.26" \
      "bgutil-ytdlp-pot-provider==2.0.2"

WORKDIR /srv
COPY --chown=node:node service.mjs start.sh ./
RUN chmod 755 /srv/start.sh

USER node
ENV PATH="/opt/yt-dlp/bin:${PATH}"
EXPOSE 8080
ENTRYPOINT ["/srv/start.sh"]

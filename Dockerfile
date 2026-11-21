FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:stable-alpine
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY docker/entrypoint.sh /entrypoint.sh
COPY --from=build /app/dist/viewer /srv/kadrokreo/viewer
COPY --from=build /app/dist/editor /srv/kadrokreo/editor
# kdr コマンド（docker run … kadrokreo kdr …）。CLI は TypeScript のまま Node で動かすので、Node 本体とソースを入れる。
# 置き場所は nginx の配信先（/srv/kadrokreo）の外なので、viewer / editor として起動しても配信されない。
RUN apk add --no-cache libstdc++ && mkdir -p /work
COPY --from=build /usr/local/bin/node /usr/local/bin/node
COPY --from=build /app/package.json /opt/kadrokreo/package.json
COPY --from=build /app/cli /opt/kadrokreo/cli
COPY --from=build /app/src /opt/kadrokreo/src
RUN printf '#!/bin/sh\nexec node /opt/kadrokreo/cli/kadrokreo.ts "$@"\n' > /usr/local/bin/kdr \
  && chmod +x /usr/local/bin/kdr && ln -s kdr /usr/local/bin/kadrokreo
EXPOSE 80
ENTRYPOINT ["/entrypoint.sh"]

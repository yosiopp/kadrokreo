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
EXPOSE 80
ENTRYPOINT ["/entrypoint.sh"]

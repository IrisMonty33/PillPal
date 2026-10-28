FROM node:20-alpine as builder

WORKDIR /app

COPY package*.json /

RUN npm ci 

COPY . .

RUN npm run build

RUN npx prisma generate


# -------

FROM node:20-alpine

WORKDIR /app

COPY package*.json ./

RUN npm ci --only=production

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/prisma ./prisma

EXPOSE 4000

CMD ["sh", "-c", "npx prisma migrate deploy && npm start"]
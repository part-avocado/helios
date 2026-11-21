# The teardrop central server. Build: docker build -t teardrop .
# It stores everything as files under /data; mount a volume there.
FROM golang:1.25-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
ARG VERSION=dev
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /teardrop ./cmd/teardrop

# distroless/static has CA certificates, needed to reach Hack Club Auth and Lookout.
FROM gcr.io/distroless/static-debian12
COPY --from=build /teardrop /teardrop
VOLUME /data
EXPOSE 8080
ENTRYPOINT ["/teardrop"]
CMD ["server", "-addr", ":8080", "-data", "/data"]

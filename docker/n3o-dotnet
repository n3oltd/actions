########################
### base
########################
FROM mcr.microsoft.com/dotnet/aspnet:7.0-jammy AS base

WORKDIR /app

########################
### build
########################
FROM mcr.microsoft.com/dotnet/sdk:7.0-jammy AS build

ARG FEED_URL
ARG PAT
ARG PROJECT

WORKDIR /src

ENV NUGET_CREDENTIALPROVIDER_SESSIONTOKENCACHE_ENABLED true
ENV VSS_NUGET_EXTERNAL_FEED_ENDPOINTS {\"endpointCredentials\": [{\"endpoint\":\"${FEED_URL}\", \"username\":\"n3oltd\", \"password\":\"${PAT}\"}]}
ENV PROJECT=${PROJECT}
ENV DLL=.dll

COPY . .
WORKDIR "/src/${PROJECT}"

RUN apt-get update
RUN apt-get install --assume-yes wget
RUN wget -qO- https://raw.githubusercontent.com/Microsoft/<Swapthisout>artifacts-credprovider/master/helpers/installcredprovider.sh | bash
RUN dotnet restore
RUN dotnet build -c Release -o /app
RUN rm -f /app/appsettings.json

########################
### publish
########################
FROM build AS publish

ARG PROJECT

RUN dotnet publish "${PROJECT}.csproj" -c Release -o /app

########################
### final
########################
FROM base AS final

ARG PROJECT

RUN apt-get update 

RUN apt-get --yes install zip unzip curl
RUN apt-get --yes install libgdiplus

WORKDIR /app
ENV ASPNETCORE_URLS http://*:80
ENV DLL="${PROJECT}.dll"

RUN echo "#!/bin/sh\ndotnet ${DLL}" > ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

ENTRYPOINT ["./entrypoint.sh"]

EXPOSE 80
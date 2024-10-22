FROM postgres:17

#install pgbackrest
RUN apt-get update &&\
    apt-get -y install pgbackrest cron sudo

# Install azure cli
#RUN curl -sL https://aka.ms/InstallAzureCLIDeb | bash

ENV POSTGRES_USER=myuser
ENV POSTGRES_PASSWORD=mypassword
ENV POSTGRES_DB=mydatabase

EXPOSE 5432

COPY custom-entrypoint.sh /usr/local/bin/custom-entrypoint.sh
RUN chmod +x /usr/local/bin/custom-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/custom-entrypoint.sh"]
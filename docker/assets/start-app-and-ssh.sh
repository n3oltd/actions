#!/bin/bash 
service ssh start

dotnet __PROJECT__.dll

while sleep 15; do
  ps aux | grep dotnet | grep -q -v grep
  PROCESS_STATUS=$?

  if [ $PROCESS_STATUS -ne 0 ]; then
    echo "dotnet process is dead"
    exit 1
 fi
done
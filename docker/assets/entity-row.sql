SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;

BEGIN TRANSACTION;

CREATE TABLE IF NOT EXISTS public."Entities"(
                                                "Id" UUID PRIMARY KEY,
                                                "Revision" INT,
                                                "DateTime" TIMESTAMP,
                                                "Type" VARCHAR(400),
                                                "Json" TEXT
);

COMMIT TRANSACTION;


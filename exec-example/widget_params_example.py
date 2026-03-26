# Databricks notebook source

# COMMAND ----------
dbutils.widgets.text("greeting", "hello")
dbutils.widgets.text("name", "Databricks")

# COMMAND ----------
import json

print(
    json.dumps(
        {
            "greeting": dbutils.widgets.get("greeting"),
            "name": dbutils.widgets.get("name"),
        },
        sort_keys=True,
    )
)

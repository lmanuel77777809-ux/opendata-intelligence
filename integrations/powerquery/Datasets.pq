// Datasets: estado de actualización (última carga correcta y próxima ejecución).
let
    Origen = fnOdiGet(
        "v_dataset",
        [],
        "dataset_code,name,source_code,category_code,update_frequency,license_code,last_success_at,next_run_at,last_run_status,last_run_finished_at",
        "dataset_code.asc"
    ),
    Tipos = Table.TransformColumnTypes(
        Origen,
        {
            {"last_success_at", type datetimezone},
            {"next_run_at", type datetimezone},
            {"last_run_finished_at", type datetimezone}
        }
    )
in
    Tipos

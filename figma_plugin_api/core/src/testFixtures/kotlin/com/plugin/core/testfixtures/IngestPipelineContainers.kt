package com.plugin.core.testfixtures

import io.r2dbc.postgresql.extension.CodecRegistrar
import io.r2dbc.spi.ConnectionFactories
import io.r2dbc.spi.ConnectionFactoryOptions
import io.r2dbc.spi.IsolationLevel
import io.r2dbc.spi.Option
import liquibase.Liquibase
import liquibase.database.DatabaseFactory
import liquibase.database.jvm.JdbcConnection
import liquibase.resource.ClassLoaderResourceAccessor
import org.jetbrains.exposed.v1.core.vendors.PostgreSQLDialect
import org.jetbrains.exposed.v1.r2dbc.R2dbcDatabase
import org.jetbrains.exposed.v1.r2dbc.R2dbcDatabaseConfig
import org.testcontainers.containers.GenericContainer
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.containers.wait.strategy.Wait
import java.sql.DriverManager

/**
 * Container singletons reused across IT classes inside one JVM. Each container is
 * lazy and never `stop()`-ed; Testcontainers' Ryuk reaper cleans them on JVM exit.
 * Build helpers convert containers to clients (R2DBC database, MinIO endpoint, etc).
 */
object IngestPipelineContainers {

    val postgres: PostgreSQLContainer<*> by lazy {
        PostgreSQLContainer("postgres:15-alpine").apply {
            withDatabaseName("ingest_test")
            withUsername("test")
            withPassword("test")
            start()
            runLiquibase(this)
        }
    }

    val redis: GenericContainer<*> by lazy {
        GenericContainer<Nothing>("redis:7-alpine").apply {
            withExposedPorts(6379)
            start()
        }
    }

    val minio: GenericContainer<*> by lazy {
        GenericContainer<Nothing>("quay.io/minio/minio:RELEASE.2024-10-13T13-34-11Z").apply {
            withCommand("server /data")
            withExposedPorts(9000)
            withEnv("MINIO_ROOT_USER", "minioadmin")
            withEnv("MINIO_ROOT_PASSWORD", "minioadmin")
            waitingFor(Wait.forHttp("/minio/health/live").forPort(9000))
            start()
        }
    }

    fun redisHost(): String = redis.host
    fun redisPort(): Int = redis.firstMappedPort

    fun minioEndpoint(): String = "http://${minio.host}:${minio.firstMappedPort}"

    /**
     * Builds an Exposed R2dbcDatabase against the running postgres container. Caller
     * supplies an [EnumCodec] covering every postgres enum used by the schema under test.
     */
    fun buildR2dbcDatabase(enumCodec: CodecRegistrar): R2dbcDatabase {
        val pg = postgres
        val options = ConnectionFactoryOptions.builder()
            .from(ConnectionFactoryOptions.parse("r2dbc:postgresql://${pg.host}:${pg.firstMappedPort}/${pg.databaseName}"))
            .option(ConnectionFactoryOptions.USER, pg.username)
            .option(ConnectionFactoryOptions.PASSWORD, pg.password)
            .option(Option.valueOf("extensions"), listOf(enumCodec))
            .build()
        val cf = ConnectionFactories.get(options)
        return R2dbcDatabase.connect(
            connectionFactory = cf,
            databaseConfig = R2dbcDatabaseConfig {
                defaultMaxAttempts = 3
                defaultR2dbcIsolationLevel = IsolationLevel.READ_COMMITTED
                explicitDialect = PostgreSQLDialect()
            },
        )
    }

    /**
     * Liquibase runs against the JDBC URL exposed by the container so the schema is
     * present before the R2DBC client connects. Idempotent — the changelog tracks state.
     */
    private fun runLiquibase(pg: PostgreSQLContainer<*>) {
        DriverManager.getConnection(pg.jdbcUrl, pg.username, pg.password).use { conn ->
            val database = DatabaseFactory.getInstance().findCorrectDatabaseImplementation(JdbcConnection(conn))
            Liquibase("db/changelog/master.yaml", ClassLoaderResourceAccessor(), database).use { it.update("") }
        }
    }
}

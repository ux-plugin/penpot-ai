package com.plugin.processor.config

import com.plugin.core.replay.SessionMetadataRepository
import io.r2dbc.spi.ConnectionFactory
import io.r2dbc.spi.IsolationLevel
import org.jetbrains.exposed.v1.core.vendors.PostgreSQLDialect
import org.jetbrains.exposed.v1.r2dbc.R2dbcDatabase
import org.jetbrains.exposed.v1.r2dbc.R2dbcDatabaseConfig
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration

/** Minimal R2DBC wiring for the processor worker. No enum codecs — session_metadata
 * uses plain VARCHAR/BIGINT/INT columns. */
@Configuration
class R2dbcConfig {
    @Bean
    fun exposedR2dbcDatabase(connectionFactory: ConnectionFactory): R2dbcDatabase = R2dbcDatabase.connect(
        connectionFactory = connectionFactory,
        databaseConfig = R2dbcDatabaseConfig {
            defaultMaxAttempts = 3
            defaultR2dbcIsolationLevel = IsolationLevel.READ_COMMITTED
            explicitDialect = PostgreSQLDialect()
        },
    )

    @Bean
    fun sessionMetadataRepository(db: R2dbcDatabase): SessionMetadataRepository = SessionMetadataRepository(db)
}

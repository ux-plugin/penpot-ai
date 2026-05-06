package com.plugin.api.config

import com.plugin.api.features.auth.core.SocialProvider
import com.plugin.api.features.user.UserRole
import io.r2dbc.postgresql.codec.EnumCodec
import io.r2dbc.spi.ConnectionFactory
import io.r2dbc.spi.IsolationLevel
import io.r2dbc.spi.Option
import org.jetbrains.exposed.v1.core.vendors.PostgreSQLDialect
import org.jetbrains.exposed.v1.r2dbc.R2dbcDatabase
import org.jetbrains.exposed.v1.r2dbc.R2dbcDatabaseConfig
import org.springframework.boot.autoconfigure.r2dbc.ConnectionFactoryOptionsBuilderCustomizer
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration

/** Configuration for R2DBC with Exposed */
@Configuration
class R2dbcConfig {
    /** Customize R2DBC connection factory options to support PostgreSQL enums */
    @Bean
    fun connectionFactoryOptionsBuilderCustomizer(): ConnectionFactoryOptionsBuilderCustomizer =
        ConnectionFactoryOptionsBuilderCustomizer { builder ->
            builder.option(
                Option.valueOf("extensions"),
                listOf(
                    EnumCodec
                        .builder()
                        .withEnum("user_roles", UserRole::class.java)
                        .withEnum("social_providers", SocialProvider::class.java)
                        .build(),
                ),
            )
        }

    /** Configure Exposed R2DBC database instance */
    @Bean
    fun exposedR2dbcDatabase(connectionFactory: ConnectionFactory): R2dbcDatabase = R2dbcDatabase.connect(
        connectionFactory = connectionFactory,
        databaseConfig =
        R2dbcDatabaseConfig {
            defaultMaxAttempts = 3
            defaultR2dbcIsolationLevel = IsolationLevel.READ_COMMITTED
            explicitDialect = PostgreSQLDialect()
        },
    )
}

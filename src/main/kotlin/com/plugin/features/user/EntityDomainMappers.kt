package com.plugin.features.user

fun User.toEntity(): UserEntity {
    return UserEntity().apply {
        name = this@toEntity.name
        password = this@toEntity.password
        username = this@toEntity.username
        companionAppConnected = this@toEntity.companionAppConnected
        companionAppPort = this@toEntity.companionAppPort
    }
}

fun UserEntity.toModel(): User {
    return User().apply {
        name = this@toModel.name
        password = this@toModel.password
        username = this@toModel.username
        companionAppConnected = this@toModel.companionAppConnected
        companionAppPort = this@toModel.companionAppPort
    }
}
package com.plugin.api.features.auth.core

class AccountAlreadyLinkedException(message: String) : RuntimeException(message)

class NotFoundException(message: String) : RuntimeException(message)

class NotAllowedException(message: String) : RuntimeException(message)

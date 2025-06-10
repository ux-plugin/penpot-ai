client<llm> CustomGPT4o {
  provider openai-generic
  options {
    model "gpt-4o"
    api_key env.OPENAI_API_KEY
    base_url env.OPENAI_BASE_URL
  }
}

client<llm> CustomGPT4oMini {
  provider openai-generic
  options {
    model "gpt-4o-mini"
    api_key env.OPENAI_API_KEY
    base_url env.OPENAI_BASE_URL
  }
}
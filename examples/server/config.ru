require 'opal-sprockets'

Opal.use_gem 'opal-httpget'

run Opal::Server.new { |server|
  server.main = 'application'
  server.append_path 'app'
}
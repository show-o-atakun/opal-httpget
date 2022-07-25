require 'opal'
require 'opal/httpget'

Opal::Httpget::Sender.new.get("test.json") do |s|
    puts s.response_text
end
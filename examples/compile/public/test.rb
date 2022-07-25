require 'opal'
require 'opal/httpget'

include Opal::Httpget

Sender.new.get("test.json") do |s|
    preload_images(["test.jpg"]) do |s2|
        puts "Finish loading image."
        Element[".testimage"]["src"] = "test.jpg"
    end
end
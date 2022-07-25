require "sinatra"

class App < Sinatra::Base
    get "/" do
        erb :test
    end
end


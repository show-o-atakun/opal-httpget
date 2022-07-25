# frozen_string_literal: true


if RUBY_ENGINE == "opal"
  puts "Ruby engine is opal"
  require_relative "httpget/version"
  require 'jquery-3.6.0.min'
  require 'opal-jquery'
else
  puts "Ruby engine is ruby"
  Opal.append_path File.expand_path("..", __FILE__).untaint
  Opal.append_path File.expand_path(".", __FILE__).untaint
  
  require_relative "httpget/version"
  # require_relative '../jquery-3.6.0.min.js'
  require "opal"
  require 'opal-jquery'
end

module Opal
  module Httpget
    class Error < StandardError; end

    class Sender
      attr_reader :response_text

      def initialize()
        @response_text = nil
      end

      def get(file, &next_proc)
    
        ans = ""
    
        %x{
          // リクエスト定義
          var request = new XMLHttpRequest()
          request.open('GET', file, true)
          request.responseType = 'text'
    
          // ロード時は変数ansへ受け渡し
          request.onload = () =>  {
            ans = request.responseText
          }
    
          // ロード完了したらjsonパースして、画像をプリロード。そしてサイトのメインプログラム実行
          request.onloadend = () => {
            #{
              @response_text = ans
              yield self
            }
          }
    
          // 読み込みエラー時の処理はここに書くらしいです
          request.onerror = () => {}
    
          request.send()
        }
      end
    end

    module_function

    ##  画像プリロードの構文。参考: https://www.webdesignleaves.com/wp/jquery/1355/
    def mypreload(files)
      %x{
        for(var i = 0; i< files.length; i++){
            $("<img>").attr("src", files[i]);
        }
      }
    end

    ##  ここで、先に画像ファイルを読み込む。
    def preload_images(files, &next_proc)
      imnum, targetnum = 0, files.length
      mypreload(files)
      yield
    end

  end
end
